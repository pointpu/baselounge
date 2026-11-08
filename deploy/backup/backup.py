#!/usr/bin/env python3
"""One-shot PostgreSQL backup to a dedicated prefix in S3-compatible storage."""

import hashlib
import json
import os
import re
import subprocess
import tempfile
import uuid
from dataclasses import dataclass, field
from datetime import datetime, timedelta, timezone
from pathlib import Path
from urllib.parse import parse_qsl, unquote, urlsplit


RETENTION_DAYS = {"daily": 6, "weekly": 27, "monthly": 89}
BASENAME = re.compile(r"baselounge-\d{8}T\d{6}Z-[0-9a-f]{8}\.dump\Z")


@dataclass(frozen=True)
class Settings:
    database_url: str = field(repr=False)
    bucket: str
    endpoint: str | None = None
    region: str = "us-east-1"
    prefix: str = "baselounge/postgres/"
    addressing_style: str = "path"

    @classmethod
    def from_env(cls, env=None):
        env = os.environ if env is None else env
        for key in ("DATABASE_URL", "S3_BUCKET", "AWS_ACCESS_KEY_ID", "AWS_SECRET_ACCESS_KEY"):
            if not env.get(key, "").strip():
                raise ValueError(f"Required variable {key} is missing")
        database_url = env["DATABASE_URL"].strip()
        if urlsplit(database_url).scheme not in ("postgres", "postgresql"):
            raise ValueError("DATABASE_URL must be a PostgreSQL connection URL")
        endpoint = env.get("S3_ENDPOINT", "").strip() or None
        if endpoint:
            url = urlsplit(endpoint)
            if (url.scheme != "https" or not url.hostname or url.username is not None
                    or url.password is not None or url.query or url.fragment):
                raise ValueError("S3_ENDPOINT must be an HTTPS URL without credentials or query")
        prefix = env.get("S3_PREFIX", "baselounge/postgres/").strip().strip("/")
        if (not prefix or not re.fullmatch(r"[A-Za-z0-9._/-]+", prefix)
                or any(part in ("", ".", "..") for part in prefix.split("/"))):
            raise ValueError("S3_PREFIX must be a nonempty dedicated object prefix")
        style = env.get("S3_ADDRESSING_STYLE", "path").strip()
        if style not in ("path", "virtual"):
            raise ValueError("S3_ADDRESSING_STYLE must be path or virtual")
        return cls(database_url, env["S3_BUCKET"].strip(), endpoint,
                   env.get("S3_REGION", "").strip() or "us-east-1", prefix + "/", style)


def create_s3(settings):
    import boto3
    from botocore.config import Config

    return boto3.client("s3", endpoint_url=settings.endpoint, region_name=settings.region,
                        config=Config(connect_timeout=15, read_timeout=120,
                                      retries={"max_attempts": 5, "mode": "standard"},
                                      s3={"addressing_style": settings.addressing_style}))


def log(event, **fields):
    print(json.dumps({"event": event, **fields}, ensure_ascii=False), flush=True)


def sanitized_error(error, env=None):
    env = os.environ if env is None else env
    message = str(error)
    if isinstance(error, subprocess.CalledProcessError) and error.stderr:
        detail = error.stderr.decode("utf-8", errors="replace") if isinstance(error.stderr, bytes) else error.stderr
        message += ": " + detail.strip()
    secrets = [value for key, value in env.items() if len(value) >= 4 and
               re.search(r"SECRET|TOKEN|PASSWORD|ACCESS_KEY|DATABASE_URL|S3_ENDPOINT", key)]
    database = urlsplit(env.get("DATABASE_URL", ""))
    if database.password:
        secrets.extend([database.password, unquote(database.password)])
    for secret in sorted(secrets, key=len, reverse=True):
        message = message.replace(secret, "[redacted]")
    message = re.sub(r"\b[a-zA-Z][a-zA-Z0-9+.-]*://[^\s\"'<>]+", "[redacted-url]", message)
    return message[:500]


def run_pg(argv, settings, timeout):
    env = dict(os.environ)
    # Environment defaults do not expand a URI stored in PGDATABASE. Pass libpq
    # connection fields separately, keeping the password out of process arguments.
    database = urlsplit(settings.database_url)
    env.update({"PGHOST": database.hostname or "localhost",
                "PGPORT": str(database.port or 5432),
                "PGUSER": unquote(database.username or ""),
                "PGPASSWORD": unquote(database.password or ""),
                "PGDATABASE": unquote(database.path.lstrip("/"))})
    env.pop("PGSERVICE", None)
    env["PGCONNECT_TIMEOUT"] = "30"
    parameters = {"sslmode": "PGSSLMODE", "sslrootcert": "PGSSLROOTCERT",
                  "sslcert": "PGSSLCERT", "sslkey": "PGSSLKEY",
                  "application_name": "PGAPPNAME", "options": "PGOPTIONS",
                  "channel_binding": "PGCHANNELBINDING", "connect_timeout": "PGCONNECT_TIMEOUT"}
    for key, value in parse_qsl(database.query):
        if key in parameters:
            env[parameters[key]] = value
    subprocess.run(argv, env=env, check=True, stdout=subprocess.PIPE,
                   stderr=subprocess.PIPE, timeout=timeout)


def validate_archive(path, settings):
    run_pg(["pg_restore", "--list", str(path)], settings, timeout=120)


def checksum(path):
    digest = hashlib.sha256()
    with open(path, "rb") as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def list_managed(client, settings, tier):
    prefix = settings.prefix + tier + "/"
    objects, token, seen_tokens = [], None, set()
    while True:
        args = {"Bucket": settings.bucket, "Prefix": prefix}
        if token:
            args["ContinuationToken"] = token
        page = client.list_objects_v2(**args)
        for item in page.get("Contents", []):
            key = item["Key"]
            if not key.startswith(prefix) or not BASENAME.fullmatch(key[len(prefix):]):
                continue
            modified = item.get("LastModified")
            if not isinstance(modified, datetime) or modified.tzinfo is None:
                raise ValueError("S3 returned an invalid backup modification timestamp")
            objects.append({"Key": key, "LastModified": modified.astimezone(timezone.utc)})
        if not page.get("IsTruncated"):
            return objects
        token = page.get("NextContinuationToken")
        if not token or token in seen_tokens:
            raise ValueError("S3 returned an invalid pagination token")
        seen_tokens.add(token)


def verify_uploaded(client, settings, key, size, sha256):
    head = client.head_object(Bucket=settings.bucket, Key=key)
    if head.get("ContentLength") != size or head.get("Metadata", {}).get("sha256") != sha256:
        raise ValueError("Uploaded backup size or checksum metadata did not match")


def cleanup(client, settings, now):
    # Finish every listing before deleting anything, so listing errors preserve all backups.
    inventory = {tier: list_managed(client, settings, tier) for tier in RETENTION_DAYS}
    deleted = 0
    for tier, days in RETENTION_DAYS.items():
        objects = sorted(inventory[tier], key=lambda item: (item["LastModified"], item["Key"]))
        cutoff = now - timedelta(days=days)
        for item in objects[:-1]:  # Always keep the newest backup in each tier.
            if item["LastModified"] < cutoff:
                client.delete_object(Bucket=settings.bucket, Key=item["Key"])
                deleted += 1
    log("retention_complete", deleted=deleted)


def run_backup(settings, client, now=None):
    now = datetime.now(timezone.utc) if now is None else now
    if now.tzinfo is None:
        raise ValueError("Backup time must include a timezone")
    now = now.astimezone(timezone.utc)
    # Initialize long-term tiers immediately; subsequent runs use calendar boundaries.
    inventory = {tier: list_managed(client, settings, tier) for tier in RETENTION_DAYS}
    tiers = ["daily"]
    if now.weekday() == 6 or not inventory["weekly"]:
        tiers.append("weekly")
    if now.day == 1 or not inventory["monthly"]:
        tiers.append("monthly")
    name = f"baselounge-{now:%Y%m%dT%H%M%SZ}-{uuid.uuid4().hex[:8]}.dump"
    log("backup_started", tiers=tiers)
    with tempfile.TemporaryDirectory(prefix="baselounge-backup-") as temporary:
        archive = Path(temporary) / name
        run_pg(["pg_dump", "--format=custom", "--no-owner", "--no-acl", "--file", str(archive)],
               settings, timeout=1800)
        if not archive.is_file() or archive.stat().st_size == 0:
            raise ValueError("PostgreSQL dump is empty")
        validate_archive(archive, settings)
        size, sha256 = archive.stat().st_size, checksum(archive)
        for tier in tiers:
            key = settings.prefix + tier + "/" + name
            client.upload_file(str(archive), settings.bucket, key,
                               ExtraArgs={"ContentType": "application/octet-stream",
                                          "Metadata": {"sha256": sha256}})
            verify_uploaded(client, settings, key, size, sha256)
            log("backup_uploaded", tier=tier, bytes=size)
        # Verify bytes retrieved from storage, beyond trusting uploaded metadata.
        downloaded = Path(temporary) / "downloaded.dump"
        client.download_file(settings.bucket, settings.prefix + "daily/" + name, str(downloaded))
        if downloaded.stat().st_size != size or checksum(downloaded) != sha256:
            raise ValueError("Downloaded backup checksum did not match")
        validate_archive(downloaded, settings)
        log("backup_verified", bytes=size, sha256=sha256)
        cleanup(client, settings, now)
    log("backup_complete", tiers=tiers)


def main():
    try:
        settings = Settings.from_env()
        run_backup(settings, create_s3(settings))
        return 0
    except Exception as error:
        log("backup_failed", error_type=type(error).__name__, message=sanitized_error(error))
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
