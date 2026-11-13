import importlib.util
import json
from pathlib import Path
import tempfile
import time
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location('refresh', Path(__file__).with_name('refresh.py'))
refresh = importlib.util.module_from_spec(spec)
spec.loader.exec_module(refresh)
A = '0x' + 'aB' * 20
B = '0x' + 'cd' * 20


def export(date='11/09/2026', address=A, count=1):
    return f'''<sdnList xmlns="{refresh.NS[1:-1]}">
      <publshInformation><Publish_Date>{date}</Publish_Date><Record_Count>{count}</Record_Count></publshInformation>
      <sdnEntry><idList>
        <id><idType>Digital Currency Address - ETH</idType><idNumber>{address}</idNumber></id>
        <id><idType>Digital Currency Address - ARB</idType><idNumber>{address}</idNumber></id>
        <id><idType>Digital Currency Address - XBT</idType><idNumber>bc1-test-bitcoin-address</idNumber></id>
        <id><idType>Passport</idType><idNumber>{B}</idNumber></id>
      </idList></sdnEntry>
    </sdnList>'''.encode()


class RefreshTests(unittest.TestCase):
    def test_only_digital_evm_addresses_normalized_and_deduplicated(self):
        self.assertEqual(refresh.extract(export())['addresses'], [A.lower()])

    def test_invalid_downloads_are_rejected(self):
        for data in [b'<html>error</html>', b'<sdnList/>', export(count=2), export(address='0x1234'), export(address=''), b'<!DOCTYPE sdnList><sdnList/>', export(date='12/31/2099')]:
            with self.subTest(data=data[:80]), self.assertRaises((ValueError, StopIteration)):
                refresh.extract(data)

    def test_encoded_dtd_cannot_bypass_declaration_checks(self):
        document = '<!DOCTYPE sdnList [<!ENTITY address "' + A + '">]>' + export(address='&address;').decode()
        for encoding in ['utf-8', 'utf-16', 'utf-16-le', 'utf-32']:
            with self.subTest(encoding=encoding), self.assertRaises(ValueError):
                refresh.extract(document.encode(encoding))

    def test_failures_keep_snapshot_and_removals_replace_it(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / 'addresses.json'
            with patch.object(refresh, 'download', return_value=export()):
                refresh.refresh(path)
            original = path.read_bytes()
            for result in [b'bad xml', export(date='11/08/2026'), export(address='0x1234')]:
                with patch.object(refresh, 'download', return_value=result), self.assertRaises(Exception):
                    refresh.refresh(path)
                self.assertEqual(path.read_bytes(), original)
            with patch.object(refresh, 'download', side_effect=TimeoutError), self.assertRaises(TimeoutError):
                refresh.refresh(path)
            self.assertEqual(path.read_bytes(), original)
            with patch.object(refresh, 'download', return_value=export(address=B)):
                refresh.refresh(path)
            self.assertEqual(refresh.load(path)['addresses'], [B])
            self.assertEqual(path.stat().st_mode & 0o777, 0o644)

    def test_missing_stale_future_and_bad_files_are_unhealthy(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / 'addresses.json'
            with self.assertRaises(FileNotFoundError):
                refresh.load(path)
            with patch.object(refresh, 'download', return_value=export()):
                refresh.refresh(path)
            snapshot = json.loads(path.read_text())
            for fetched in [int(time.time()) - 86401, int(time.time()) + 3600, True, 0]:
                path.write_text(json.dumps({**snapshot, 'fetched_at': fetched}))
                with self.subTest(fetched=fetched), self.assertRaises(ValueError):
                    refresh.load(path)

    def test_redirects_require_approved_https_hosts(self):
        for url in ['http://sanctionslistservice.ofac.treas.gov/a', 'https://example.com/a', 'https://sanctionslistservice.ofac.treas.gov.evil.test/a', 'https://sanctionslistservice.ofac.treas.gov:8443/a']:
            with self.subTest(url=url), self.assertRaises(ValueError):
                refresh.checked_url(url)
        self.assertEqual(refresh.checked_url(refresh.SOURCE), refresh.SOURCE)


if __name__ == '__main__':
    unittest.main()
