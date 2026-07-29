import json
import tempfile
from pathlib import Path
from unittest import TestCase, main, mock

import importlib.util

MODULE_PATH = Path(__file__).with_name("blob-archive-proxy.py")
SPEC = importlib.util.spec_from_file_location("blob_archive_proxy", MODULE_PATH)
assert SPEC and SPEC.loader
proxy = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(proxy)


class BlobArchiveProxyTest(TestCase):
    def test_rejects_bad_blob_length(self) -> None:
        with self.assertRaisesRegex(ValueError, "invalid length"):
            proxy._validate_blob("0x00")

    def test_rejects_non_hex_blob(self) -> None:
        with self.assertRaisesRegex(ValueError, "non-hex"):
            proxy._validate_blob("0x" + "z" * (proxy.EXPECTED_HEX_LENGTH - 2))

    def test_cache_prevents_second_archive_request(self) -> None:
        versioned_hash = "0x01" + "ab" * 31
        blob = "0x" + "00" * 131_072
        with tempfile.TemporaryDirectory() as directory:
            with (
                mock.patch.object(proxy, "CACHE_DIR", Path(directory)),
                mock.patch.object(proxy.urllib.request, "urlopen") as urlopen,
            ):
                urlopen.return_value.__enter__.return_value = [blob]
                # json.load needs a file-like response; use a small compatible shim.
                urlopen.return_value.__enter__.return_value = mock.Mock(
                    read=mock.Mock(return_value=json.dumps(blob).encode())
                )
                self.assertEqual(proxy.fetch_blob(versioned_hash), blob)
                self.assertEqual(proxy.fetch_blob(versioned_hash), blob)
                urlopen.assert_called_once()


if __name__ == "__main__":
    main()
