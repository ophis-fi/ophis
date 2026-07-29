import json
import unittest
import unittest.mock as mock
from pathlib import Path

import importlib.util

MODULE_PATH = Path(__file__).with_name("blob-archive-proxy.py")
SPEC = importlib.util.spec_from_file_location("blob_archive_proxy", MODULE_PATH)
assert SPEC and SPEC.loader
proxy = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(proxy)


class BlobArchiveProxyTest(unittest.TestCase):
    def test_rejects_bad_blob_length(self) -> None:
        with self.assertRaisesRegex(ValueError, "invalid length"):
            proxy._validate_blob("0x00")

    def test_rejects_non_hex_blob(self) -> None:
        with self.assertRaisesRegex(ValueError, "non-hex"):
            proxy._validate_blob("0x" + "z" * (proxy.EXPECTED_HEX_LENGTH - 2))

    def test_valid_blob_is_returned_without_persistent_caching(self) -> None:
        versioned_hash = "0x01" + "ab" * 31
        blob = "0x" + "00" * 131_072
        with mock.patch.object(proxy.urllib.request, "urlopen") as urlopen:
            urlopen.return_value.__enter__.return_value = mock.Mock(
                read=mock.Mock(return_value=json.dumps(blob).encode())
            )
            self.assertEqual(proxy.fetch_blob(versioned_hash), blob)
            self.assertEqual(proxy.fetch_blob(versioned_hash), blob)
            self.assertEqual(urlopen.call_count, 2)


if __name__ == "__main__":
    unittest.main()
