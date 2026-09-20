"""S3-compatible object storage client (MinIO emulator in dev, Cloudflare R2 in cloud).

One boto3 code path for every environment: the same ``OBJECT_STORAGE_*`` vars
carry the endpoint and credentials whoever serves them.
``OBJECT_STORAGE_PROVIDER`` decides how a bucket is made publicly readable (a
MinIO bucket policy locally, a connected domain on R2) and how buckets are
created/deleted (S3 API on MinIO, Cloudflare REST API on R2).

Objects live in two buckets: the untouched original in the private bucket
(so variants can be regenerated later) and the derived variants in the
public bucket (served directly over HTTP/CDN).
"""

from __future__ import annotations

import json
import logging
import os
from typing import Optional

import boto3
import httpx
from botocore.client import Config
from botocore.exceptions import ClientError

logger = logging.getLogger(__name__)

PROVIDER_MINIO = "minio"
PROVIDER_R2 = "r2"

CLOUDFLARE_API_BASE = "https://api.cloudflare.com/client/v4"

# Variants are addressed by a uuid-bearing key, so they can never change in place.
PUBLIC_CACHE_CONTROL = "public, max-age=31536000, immutable"

_PROTECTED_BUCKET_PREFIXES = ("movida-prod-", "movida-staging-")


class ObjectStorageError(RuntimeError):
    """Raised when the storage backend is misconfigured or unreachable."""


def get_provider() -> str:
    return os.getenv("OBJECT_STORAGE_PROVIDER", PROVIDER_MINIO).strip().lower()


def _required(name: str) -> str:
    value = os.getenv(name, "").strip()
    if not value:
        raise ObjectStorageError(f"{name} is not set")
    return value


def get_public_bucket() -> str:
    return _required("OBJECT_STORAGE_BUCKET_PUBLIC")


def get_private_bucket() -> str:
    return _required("OBJECT_STORAGE_BUCKET_PRIVATE")


def _credentials() -> tuple[str, str, str]:
    """Return ``(endpoint, access_key, secret_key)``, same vars for every provider."""
    return (
        _required("OBJECT_STORAGE_ENDPOINT"),
        _required("OBJECT_STORAGE_ACCESS_KEY_ID"),
        _required("OBJECT_STORAGE_SECRET_ACCESS_KEY"),
    )


def get_client():
    """Build a boto3 S3 client for the active provider.

    Not cached: scripts and tests flip the env vars between calls.
    """
    endpoint, access_key, secret_key = _credentials()
    return boto3.client(
        "s3",
        endpoint_url=endpoint,
        aws_access_key_id=access_key,
        aws_secret_access_key=secret_key,
        region_name=os.getenv("OBJECT_STORAGE_REGION", "auto"),
        config=Config(
            signature_version="s3v4",
            s3={"addressing_style": "path"},
            retries={"max_attempts": 3, "mode": "standard"},
        ),
    )


def get_public_base_url() -> str:
    """Base URL the browser uses to fetch public objects (no trailing slash)."""
    explicit = os.getenv("OBJECT_STORAGE_PUBLIC_BASE_URL", "").strip()
    if explicit:
        return explicit.rstrip("/")
    endpoint, _, _ = _credentials()
    if get_provider() == PROVIDER_R2:
        # The R2 S3 endpoint requires a SigV4 signature, so it can never serve
        # a browser <img>. Public reads go through a connected domain instead.
        raise ObjectStorageError(
            "OBJECT_STORAGE_PUBLIC_BASE_URL is not set — R2 public objects must "
            "be served from a connected domain (a custom domain, or the managed "
            "https://pub-<id>.r2.dev one), not from the S3 endpoint"
        )
    return f"{endpoint.rstrip('/')}/{get_public_bucket()}"


def public_url(key: str) -> str:
    return f"{get_public_base_url()}/{key.lstrip('/')}"


def bucket_exists(client, bucket: str) -> bool:
    try:
        client.head_bucket(Bucket=bucket)
        return True
    except ClientError as exc:
        code = exc.response.get("Error", {}).get("Code", "")
        if code in ("404", "NoSuchBucket", "NotFound"):
            return False
        raise


def _r2_api(method: str, path: str, **kwargs) -> httpx.Response:
    account_id = os.getenv("CLOUDFLARE_ACCOUNT_ID", "").strip()
    token = os.getenv("CLOUDFLARE_R2_API_TOKEN", "").strip()
    if not (account_id and token):
        raise ObjectStorageError(
            "R2 bucket management needs CLOUDFLARE_ACCOUNT_ID and "
            "CLOUDFLARE_R2_API_TOKEN (R2 S3 tokens are object-scoped and cannot "
            "create or delete buckets)"
        )
    url = f"{CLOUDFLARE_API_BASE}/accounts/{account_id}/r2/buckets{path}"
    return httpx.request(
        method,
        url,
        headers={"Authorization": f"Bearer {token}"},
        timeout=30.0,
        **kwargs,
    )


def _r2_api_error(action: str, bucket: str, response: httpx.Response) -> str:
    hint = ""
    if response.status_code in (401, 403):
        hint = (
            " — CLOUDFLARE_R2_API_TOKEN needs the account permission "
            "'Workers R2 Storage: Edit'"
        )
    return f"Cloudflare API refused to {action} bucket {bucket}: {response.text}{hint}"


def _create_bucket(client, bucket: str) -> None:
    if get_provider() != PROVIDER_R2:
        client.create_bucket(Bucket=bucket)
        return
    response = _r2_api("POST", "", json={"name": bucket})
    if response.status_code == 409:
        return
    if response.status_code >= 400:
        raise ObjectStorageError(_r2_api_error("create", bucket, response))


def _delete_bucket(client, bucket: str) -> None:
    if get_provider() != PROVIDER_R2:
        client.delete_bucket(Bucket=bucket)
        return
    response = _r2_api("DELETE", f"/{bucket}")
    if response.status_code >= 400 and response.status_code != 404:
        raise ObjectStorageError(_r2_api_error("delete", bucket, response))


def _public_read_policy(bucket: str) -> str:
    return json.dumps(
        {
            "Version": "2012-10-17",
            "Statement": [
                {
                    "Effect": "Allow",
                    "Principal": {"AWS": ["*"]},
                    "Action": ["s3:GetObject"],
                    "Resource": [f"arn:aws:s3:::{bucket}/*"],
                }
            ],
        }
    )


def ensure_buckets(client=None) -> list[str]:
    """Create the public/private buckets when missing. Returns created names."""
    client = client or get_client()
    public_bucket = get_public_bucket()
    created: list[str] = []
    for bucket in (public_bucket, get_private_bucket()):
        if bucket_exists(client, bucket):
            continue
        _create_bucket(client, bucket)
        created.append(bucket)
        logger.info("Created bucket %s", bucket)

    # R2 serves the public bucket through a connected domain, not a policy.
    if get_provider() == PROVIDER_MINIO:
        client.put_bucket_policy(
            Bucket=public_bucket, Policy=_public_read_policy(public_bucket)
        )
    return created


def object_exists(key: str, bucket: Optional[str] = None, client=None) -> bool:
    client = client or get_client()
    try:
        client.head_object(Bucket=bucket or get_public_bucket(), Key=key)
        return True
    except ClientError as exc:
        code = exc.response.get("Error", {}).get("Code", "")
        if code in ("404", "NoSuchKey", "NotFound"):
            return False
        raise


def put_public(key: str, data: bytes, content_type: str, client=None) -> None:
    client = client or get_client()
    client.put_object(
        Bucket=get_public_bucket(),
        Key=key,
        Body=data,
        ContentType=content_type,
        CacheControl=PUBLIC_CACHE_CONTROL,
    )


def put_private(key: str, data: bytes, content_type: str, client=None) -> None:
    client = client or get_client()
    client.put_object(
        Bucket=get_private_bucket(),
        Key=key,
        Body=data,
        ContentType=content_type,
    )


def delete_prefix(prefix: str, bucket: str, client=None) -> int:
    """Delete every object under ``prefix``. Returns the number removed."""
    client = client or get_client()
    removed = 0
    paginator = client.get_paginator("list_objects_v2")
    for page in paginator.paginate(Bucket=bucket, Prefix=prefix):
        keys = [{"Key": item["Key"]} for item in page.get("Contents", [])]
        if not keys:
            continue
        client.delete_objects(Bucket=bucket, Delete={"Objects": keys})
        removed += len(keys)
    return removed


def empty_bucket(bucket: str, client=None) -> int:
    return delete_prefix("", bucket, client=client)


def delete_bucket(bucket: str, client=None) -> None:
    """Empty then delete a bucket. Refuses the staging/prod buckets."""
    if bucket.startswith(_PROTECTED_BUCKET_PREFIXES):
        raise ObjectStorageError(f"Refusing to delete protected bucket {bucket}")
    client = client or get_client()
    if not bucket_exists(client, bucket):
        return
    empty_bucket(bucket, client=client)
    _delete_bucket(client, bucket)
    logger.info("Deleted bucket %s", bucket)
