import math
import base64

_KEY_DIVISOR = 3600
_KEY_PREFIX  = "SECRET_KEY_"

def decrypt_url(encrypted_b64: str, timestamp: int) -> str:
    """Reverse-engineered XOR decryption from get.bunkrr.su/js/src.enc.js"""
    key_str   = _KEY_PREFIX + str(math.floor(timestamp / _KEY_DIVISOR))
    raw_bytes = base64.b64decode(encrypted_b64)
    key_bytes = key_str.encode("utf-8")
    return bytearray(
        b ^ key_bytes[i % len(key_bytes)] for i, b in enumerate(raw_bytes)
    ).decode("utf-8", errors="replace")
