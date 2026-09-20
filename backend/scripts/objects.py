"""Provision and tear down the object-storage buckets for an environment.

Used by the start/stop tasks so a dev or scenario environment boots with
working buckets whether it points at the MinIO emulator or real Cloudflare R2.
"""

import argparse
import logging
import os
import sys

import httpx

from backend.services import object_storage

logging.basicConfig(level=logging.INFO, format="%(levelname)s: %(message)s")
logger = logging.getLogger(__name__)

CLOUDFLARE_API_BASE = object_storage.CLOUDFLARE_API_BASE


def _enable_r2_public_domain(bucket: str) -> str | None:
    """Turn on the managed r2.dev domain and return its base URL.

    Only meaningful for throwaway scenario buckets — staging/prod serve their
    public bucket through a custom domain configured once in the dashboard.
    """
    account_id = os.getenv("CLOUDFLARE_ACCOUNT_ID", "")
    token = os.getenv("CLOUDFLARE_R2_API_TOKEN", "")
    if not (account_id and token):
        logger.warning(
            "CLOUDFLARE_ACCOUNT_ID/CLOUDFLARE_R2_API_TOKEN not set — skipping "
            "r2.dev public access for %s",
            bucket,
        )
        return None

    url = f"{CLOUDFLARE_API_BASE}/accounts/{account_id}/r2/buckets/{bucket}/domains/managed"
    response = httpx.put(
        url,
        headers={"Authorization": f"Bearer {token}"},
        json={"enabled": True},
        timeout=30.0,
    )
    if response.status_code >= 400:
        logger.warning(
            "Could not enable r2.dev public access for %s: %s",
            bucket,
            response.text,
        )
        return None
    domain = response.json().get("result", {}).get("domain")
    if not domain:
        return None
    logger.info("Public bucket %s served at https://%s", bucket, domain)
    return f"https://{domain}"


def _public_base_url() -> str | None:
    """Resolve the browser-facing base URL, enabling r2.dev when needed."""
    explicit = os.getenv("OBJECT_STORAGE_PUBLIC_BASE_URL", "").strip()
    if explicit:
        return explicit.rstrip("/")
    if object_storage.get_provider() != object_storage.PROVIDER_R2:
        return object_storage.get_public_base_url()
    return _enable_r2_public_domain(object_storage.get_public_bucket())


def _scenario_buckets() -> list[str]:
    return [object_storage.get_public_bucket(), object_storage.get_private_bucket()]


def cmd_ensure() -> None:
    client = object_storage.get_client()
    object_storage.ensure_buckets(client)
    if object_storage.get_provider() == object_storage.PROVIDER_R2:
        _public_base_url()
    logger.info("Buckets ready: %s", ", ".join(_scenario_buckets()))


def cmd_domain() -> None:
    """Write the public base URL to stdout so a task can export it."""
    base_url = _public_base_url()
    if not base_url:
        raise object_storage.ObjectStorageError(
            f"Could not resolve a public base URL for "
            f"{object_storage.get_public_bucket()}"
        )
    sys.stdout.write(f"{base_url}\n")


def cmd_reset() -> None:
    client = object_storage.get_client()
    for bucket in _scenario_buckets():
        object_storage.delete_bucket(bucket, client=client)
    cmd_ensure()


def cmd_destroy() -> None:
    client = object_storage.get_client()
    for bucket in _scenario_buckets():
        object_storage.delete_bucket(bucket, client=client)


def main() -> int:
    parser = argparse.ArgumentParser(description="Manage object storage buckets")
    parser.add_argument("command", choices=["ensure", "reset", "destroy", "domain"])
    args = parser.parse_args()

    try:
        {
            "ensure": cmd_ensure,
            "reset": cmd_reset,
            "destroy": cmd_destroy,
            "domain": cmd_domain,
        }[args.command]()
    except object_storage.ObjectStorageError as exc:
        logger.error("%s", exc)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
