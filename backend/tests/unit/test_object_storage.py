"""Unit tests for object storage configuration resolution and bucket setup."""

import json

import pytest

from backend.services import object_storage


class _StubClient:
    """Minimal S3 stand-in recording the calls ensure_buckets() makes."""

    def __init__(self, existing=()):
        self.existing = set(existing)
        self.created = []
        self.policies = {}

    def head_bucket(self, Bucket):
        if Bucket not in self.existing:
            raise object_storage.ClientError({"Error": {"Code": "404"}}, "HeadBucket")

    def create_bucket(self, Bucket):
        self.existing.add(Bucket)
        self.created.append(Bucket)

    def put_bucket_policy(self, Bucket, Policy):
        self.policies[Bucket] = Policy


@pytest.fixture
def storage_env(monkeypatch):
    monkeypatch.setenv("OBJECT_STORAGE_BUCKET_PUBLIC", "b-public")
    monkeypatch.setenv("OBJECT_STORAGE_BUCKET_PRIVATE", "b-private")
    monkeypatch.delenv("OBJECT_STORAGE_PUBLIC_BASE_URL", raising=False)
    return monkeypatch


def test_bucket_names_have_no_default(monkeypatch):
    """A missing bucket name must fail loudly, never fall back to a dev bucket."""
    monkeypatch.delenv("OBJECT_STORAGE_BUCKET_PUBLIC", raising=False)
    with pytest.raises(object_storage.ObjectStorageError) as exc:
        object_storage.get_public_bucket()
    assert "OBJECT_STORAGE_BUCKET_PUBLIC" in str(exc.value)


def test_credentials_are_provider_agnostic(storage_env):
    storage_env.setenv("OBJECT_STORAGE_PROVIDER", "r2")
    storage_env.setenv("OBJECT_STORAGE_ENDPOINT", "https://r2.example")
    storage_env.setenv("OBJECT_STORAGE_ACCESS_KEY_ID", "key")
    storage_env.setenv("OBJECT_STORAGE_SECRET_ACCESS_KEY", "secret")
    assert object_storage._credentials() == ("https://r2.example", "key", "secret")


def test_missing_endpoint_raises_instead_of_localhost_fallback(storage_env):
    storage_env.setenv("OBJECT_STORAGE_PROVIDER", "minio")
    storage_env.delenv("OBJECT_STORAGE_ENDPOINT", raising=False)
    with pytest.raises(object_storage.ObjectStorageError) as exc:
        object_storage._credentials()
    assert "OBJECT_STORAGE_ENDPOINT" in str(exc.value)


def test_r2_public_base_url_never_falls_back_to_the_s3_endpoint(storage_env):
    """The S3 endpoint needs a signature, so a browser <img> would 401 on it."""
    storage_env.setenv("OBJECT_STORAGE_PROVIDER", "r2")
    storage_env.setenv(
        "OBJECT_STORAGE_ENDPOINT", "https://acct.r2.cloudflarestorage.com"
    )
    storage_env.setenv("OBJECT_STORAGE_ACCESS_KEY_ID", "key")
    storage_env.setenv("OBJECT_STORAGE_SECRET_ACCESS_KEY", "secret")
    with pytest.raises(object_storage.ObjectStorageError) as exc:
        object_storage.get_public_base_url()
    assert "OBJECT_STORAGE_PUBLIC_BASE_URL" in str(exc.value)


def test_minio_public_base_url_uses_the_bucket_on_the_endpoint(storage_env):
    storage_env.setenv("OBJECT_STORAGE_PROVIDER", "minio")
    storage_env.setenv("OBJECT_STORAGE_ENDPOINT", "http://127.0.0.1:9000")
    storage_env.setenv("OBJECT_STORAGE_ACCESS_KEY_ID", "key")
    storage_env.setenv("OBJECT_STORAGE_SECRET_ACCESS_KEY", "secret")
    assert object_storage.public_url("a/b.webp") == (
        "http://127.0.0.1:9000/b-public/a/b.webp"
    )


def test_ensure_buckets_grants_anonymous_read_on_minio(storage_env):
    storage_env.setenv("OBJECT_STORAGE_PROVIDER", "minio")
    client = _StubClient()

    created = object_storage.ensure_buckets(client=client)

    assert created == ["b-public", "b-private"]
    policy = json.loads(client.policies["b-public"])
    statement = policy["Statement"][0]
    assert statement["Action"] == ["s3:GetObject"]
    assert statement["Resource"] == ["arn:aws:s3:::b-public/*"]
    assert "b-private" not in client.policies


def test_ensure_buckets_skips_policy_on_r2(storage_env):
    """R2 publishes the bucket through a connected domain, not a policy."""
    storage_env.setenv("OBJECT_STORAGE_PROVIDER", "r2")
    storage_env.setenv("CLOUDFLARE_ACCOUNT_ID", "acct")
    storage_env.setenv("CLOUDFLARE_R2_API_TOKEN", "token")
    storage_env.setattr(object_storage, "_r2_api", lambda *a, **k: _ApiResponse(200))
    client = _StubClient()

    object_storage.ensure_buckets(client=client)

    assert client.policies == {}


class _ApiResponse:
    def __init__(self, status_code, text=""):
        self.status_code = status_code
        self.text = text


def test_r2_buckets_are_created_through_the_cloudflare_api(storage_env):
    """R2 S3 tokens are object-scoped — CreateBucket over S3 returns AccessDenied."""
    storage_env.setenv("OBJECT_STORAGE_PROVIDER", "r2")
    storage_env.setenv("CLOUDFLARE_ACCOUNT_ID", "acct")
    storage_env.setenv("CLOUDFLARE_R2_API_TOKEN", "token")
    calls = []

    def fake_api(method, path, **kwargs):
        calls.append((method, path, kwargs.get("json")))
        return _ApiResponse(200)

    storage_env.setattr(object_storage, "_r2_api", fake_api)
    client = _StubClient()

    object_storage.ensure_buckets(client=client)

    assert client.created == []
    assert calls == [
        ("POST", "", {"name": "b-public"}),
        ("POST", "", {"name": "b-private"}),
    ]


def test_r2_bucket_management_requires_the_account_api_token(storage_env):
    storage_env.setenv("OBJECT_STORAGE_PROVIDER", "r2")
    storage_env.delenv("CLOUDFLARE_ACCOUNT_ID", raising=False)
    storage_env.delenv("CLOUDFLARE_R2_API_TOKEN", raising=False)

    with pytest.raises(object_storage.ObjectStorageError) as exc:
        object_storage.ensure_buckets(client=_StubClient())
    assert "CLOUDFLARE_R2_API_TOKEN" in str(exc.value)


def test_ensure_buckets_reapplies_policy_when_bucket_exists(storage_env):
    storage_env.setenv("OBJECT_STORAGE_PROVIDER", "minio")
    client = _StubClient(existing=["b-public", "b-private"])

    created = object_storage.ensure_buckets(client=client)

    assert created == []
    assert "b-public" in client.policies
