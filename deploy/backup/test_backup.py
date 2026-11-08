import subprocess
import unittest
from datetime import datetime, timedelta, timezone
from pathlib import Path
from unittest.mock import patch

import backup


NOW = datetime(2026, 11, 9, tzinfo=timezone.utc)
SETTINGS = backup.Settings("postgresql://user:private-password@postgres/club", "test-bucket")


class FakeS3:
    def __init__(self):
        self.objects = {}
        self.deleted = []
        self.corrupt_download = False
        self.bad_metadata = False

    def add(self, tier, age, suffix="aaaaaaaa", name=None):
        modified = NOW - timedelta(days=age)
        name = name or f"baselounge-{modified:%Y%m%dT%H%M%SZ}-{suffix}.dump"
        key = SETTINGS.prefix + tier + "/" + name
        self.objects[key] = (b"PGDMP old", {}, modified)
        return key

    def list_objects_v2(self, **kwargs):
        return {"Contents": [{"Key": key, "LastModified": value[2]}
                             for key, value in self.objects.items()
                             if key.startswith(kwargs["Prefix"])]}

    def upload_file(self, path, bucket, key, ExtraArgs):
        self.objects[key] = (Path(path).read_bytes(), ExtraArgs["Metadata"], NOW)

    def head_object(self, Bucket, Key):
        data, metadata, _ = self.objects[Key]
        return {"ContentLength": len(data), "Metadata": {} if self.bad_metadata else metadata}

    def download_file(self, bucket, key, path):
        Path(path).write_bytes(b"corrupt" if self.corrupt_download else self.objects[key][0])

    def delete_object(self, Bucket, Key):
        self.deleted.append(Key)
        del self.objects[Key]


def fake_pg(argv, settings, timeout):
    if argv[0] == "pg_dump":
        Path(argv[-1]).write_bytes(b"PGDMP complete archive")
    elif not Path(argv[-1]).read_bytes().startswith(b"PGDMP"):
        raise ValueError("Invalid archive")


class BackupTests(unittest.TestCase):
    def setUp(self):
        self.s3 = FakeS3()
        self.logger = patch.object(backup, "log").start()
        self.addCleanup(patch.stopall)

    def run_backup(self):
        with patch.object(backup, "run_pg", side_effect=fake_pg):
            backup.run_backup(SETTINGS, self.s3, NOW)

    def test_first_run_initializes_all_tiers_and_verifies_download(self):
        self.run_backup()
        self.assertEqual({key.split("/")[-2] for key in self.s3.objects},
                         {"daily", "weekly", "monthly"})
        self.assertEqual(len(self.s3.objects), 3)
        self.assertIn("backup_verified", [call.args[0] for call in self.logger.call_args_list])

    def test_regular_monday_only_creates_daily_backup(self):
        self.s3.add("weekly", 2)
        self.s3.add("monthly", 8)
        self.run_backup()
        self.assertEqual(len(self.s3.objects), 3)

    def test_retention_keeps_recent_and_ignores_foreign_objects(self):
        expired = self.s3.add("daily", 7)
        recent = self.s3.add("daily", 5)
        foreign = self.s3.add("daily", 100, name="someone-elses-backup.dump")
        nested = self.s3.add("daily", 100,
                             name="nested/baselounge-20260101T000000Z-aaaaaaaa.dump")
        weekly = self.s3.add("weekly", 100)
        monthly = self.s3.add("monthly", 100)
        self.run_backup()
        self.assertEqual(self.s3.deleted, [expired])
        for key in [recent, foreign, nested, weekly, monthly]:
            self.assertIn(key, self.s3.objects)

    def test_corrupt_download_never_triggers_retention(self):
        old = self.s3.add("daily", 100)
        self.s3.corrupt_download = True
        with self.assertRaisesRegex(ValueError, "checksum"):
            self.run_backup()
        self.assertEqual(self.s3.deleted, [])
        self.assertIn(old, self.s3.objects)

    def test_upload_metadata_mismatch_never_triggers_retention(self):
        self.s3.add("daily", 100)
        self.s3.bad_metadata = True
        with self.assertRaisesRegex(ValueError, "metadata"):
            self.run_backup()
        self.assertEqual(self.s3.deleted, [])

    def test_yandex_metadata_header_casing_is_supported(self):
        original = self.s3.head_object

        def yandex_head(**kwargs):
            head = original(**kwargs)
            head["Metadata"] = {key.capitalize(): value for key, value in head["Metadata"].items()}
            return head

        with patch.object(self.s3, "head_object", side_effect=yandex_head):
            self.run_backup()
        self.assertEqual(len(self.s3.objects), 3)

    def test_dump_failure_never_uploads_or_deletes(self):
        old = self.s3.add("daily", 100)
        with patch.object(backup, "run_pg", side_effect=subprocess.CalledProcessError(1, "pg_dump")):
            with self.assertRaises(subprocess.CalledProcessError):
                backup.run_backup(SETTINGS, self.s3, NOW)
        self.assertEqual(list(self.s3.objects), [old])
        self.assertEqual(self.s3.deleted, [])

    def test_failed_inventory_never_partially_deletes(self):
        self.s3.add("daily", 100)
        self.s3.add("daily", 0, suffix="bbbbbbbb")
        original = self.s3.list_objects_v2

        def fail_weekly(**kwargs):
            if kwargs["Prefix"].endswith("weekly/"):
                raise OSError("storage unavailable")
            return original(**kwargs)

        with patch.object(self.s3, "list_objects_v2", side_effect=fail_weekly):
            with self.assertRaises(OSError):
                backup.cleanup(self.s3, SETTINGS, NOW)
        self.assertEqual(self.s3.deleted, [])

    def test_listing_paginates_and_filters_outside_prefix(self):
        key = self.s3.add("daily", 1)
        pages = [{"IsTruncated": True, "NextContinuationToken": "page2"},
                 {"Contents": [{"Key": key, "LastModified": NOW},
                               {"Key": "other/private.dump", "LastModified": NOW}]}]
        with patch.object(self.s3, "list_objects_v2", side_effect=pages) as listing:
            objects = backup.list_managed(self.s3, SETTINGS, "daily")
        self.assertEqual([item["Key"] for item in objects], [key])
        self.assertEqual(listing.call_args.kwargs["ContinuationToken"], "page2")

    def test_pg_credentials_stay_out_of_command_arguments(self):
        with patch.object(backup.subprocess, "run") as run:
            backup.run_pg(["pg_dump", "--format=custom"], SETTINGS, 30)
        self.assertNotIn(SETTINGS.database_url, repr(run.call_args.args))
        self.assertEqual(run.call_args.kwargs["env"]["PGDATABASE"], "club")
        self.assertEqual(run.call_args.kwargs["env"]["PGHOST"], "postgres")
        self.assertEqual(run.call_args.kwargs["env"]["PGPASSWORD"], "private-password")
        self.assertTrue(run.call_args.kwargs["check"])

    def test_pg_uri_decodes_credentials_and_preserves_sslmode(self):
        settings = backup.Settings("postgresql://user:p%40ss%3Aword@postgres:5433/club?sslmode=require", "test")
        with patch.object(backup.subprocess, "run") as run:
            backup.run_pg(["pg_dump"], settings, 30)
        env = run.call_args.kwargs["env"]
        self.assertEqual((env["PGPORT"], env["PGPASSWORD"], env["PGSSLMODE"]),
                         ("5433", "p@ss:word", "require"))

    def test_error_logging_redacts_credentials_and_urls(self):
        secret = "top-secret-key"
        message = backup.sanitized_error(ValueError(f"{secret} {SETTINGS.database_url}"),
                                        {"AWS_SECRET_ACCESS_KEY": secret})
        self.assertNotIn(secret, message)
        self.assertNotIn("private-password", message)

    def test_configuration_rejects_insecure_endpoint_and_root_prefix(self):
        env = {"DATABASE_URL": SETTINGS.database_url, "S3_BUCKET": "test-bucket",
               "AWS_ACCESS_KEY_ID": "test-key", "AWS_SECRET_ACCESS_KEY": "test-secret"}
        for extra in [{"S3_ENDPOINT": "http://storage.example"}, {"S3_PREFIX": "/"}]:
            with self.subTest(extra=extra), self.assertRaises(ValueError):
                backup.Settings.from_env({**env, **extra})


if __name__ == "__main__":
    unittest.main()
