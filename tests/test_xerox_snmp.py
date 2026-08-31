import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from xerox_snmp import _ber_oid, _read_tlv, decode_getnext, decode_oid, encode_getnext


class SnmpCodecTest(unittest.TestCase):
    def test_oid_roundtrip(self) -> None:
        oid = "1.3.6.1.2.1.43.11.1.1.9.1"
        tag, raw, _ = _read_tlv(_ber_oid(oid), 0)
        self.assertEqual(tag, 0x06)
        self.assertEqual(decode_oid(raw), oid)

    def test_getnext_packet_decodes_own_shape(self) -> None:
        packet = encode_getnext("public", 42, "1.3.6.1.2.1.1.1")
        tag, _, _ = _read_tlv(packet, 0)
        self.assertEqual(tag, 0x30)
        self.assertIsNone(decode_getnext(packet))  # GETNEXT request, not a response


if __name__ == "__main__":
    unittest.main()
