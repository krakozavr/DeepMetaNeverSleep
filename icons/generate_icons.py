#!/usr/bin/env python3
"""
Simple icon generator for DeepMeta Never Sleep extension.
Creates basic PNG icons without external dependencies.
"""

import struct
import zlib

def create_png(width, height, rgb_func):
    """Create a PNG file with custom color function."""

    # PNG signature
    png = b'\x89PNG\r\n\x1a\n'

    # Create IHDR chunk
    ihdr_data = struct.pack('>IIBBBBB', width, height, 8, 2, 0, 0, 0)
    ihdr = create_chunk(b'IHDR', ihdr_data)

    # Create image data
    raw_data = b''
    for y in range(height):
        raw_data += b'\x00'  # Filter type
        for x in range(width):
            r, g, b = rgb_func(x, y, width, height)
            raw_data += bytes([r, g, b])

    # Compress and create IDAT chunk
    compressed = zlib.compress(raw_data, 9)
    idat = create_chunk(b'IDAT', compressed)

    # Create IEND chunk
    iend = create_chunk(b'IEND', b'')

    return png + ihdr + idat + iend

def create_chunk(chunk_type, data):
    """Create a PNG chunk with CRC."""
    length = struct.pack('>I', len(data))
    crc = zlib.crc32(chunk_type + data) & 0xffffffff
    crc_bytes = struct.pack('>I', crc)
    return length + chunk_type + data + crc_bytes

def icon_color(x, y, width, height):
    """Generate icon pixel color - simple eye/stay-awake design."""
    cx, cy = width / 2, height / 2
    dx, dy = x - cx, y - cy
    dist = (dx*dx + dy*dy) ** 0.5
    radius = min(width, height) / 2

    # Outer green circle
    if dist > radius * 0.95:
        return (0, 0, 0)  # Black border/transparent
    elif dist > radius * 0.78:
        return (76, 175, 80)  # Light green (#4CAF50)
    elif dist > radius * 0.62:
        return (46, 125, 50)  # Dark green (#2E7D32)

    # Eye shape (ellipse)
    eye_dist = ((dx/(radius*0.54))**2 + (dy/(radius*0.39))**2) ** 0.5
    if eye_dist > 1:
        return (46, 125, 50)  # Dark green background
    elif eye_dist > 0.43:
        return (255, 255, 255)  # White of eye
    elif eye_dist > 0.23:
        return (46, 125, 50)  # Iris (green)
    elif eye_dist > 0.12:
        return (0, 0, 0)  # Pupil
    else:
        # Highlight
        if dx > 0 and dy < 0:
            return (255, 255, 255)
        return (0, 0, 0)

def main():
    """Generate all icon sizes."""
    sizes = [16, 48, 128]

    for size in sizes:
        filename = f'icon{size}.png'
        print(f'Generating {filename}...')
        png_data = create_png(size, size, icon_color)

        with open(filename, 'wb') as f:
            f.write(png_data)

        print(f'  Created {filename} ({len(png_data)} bytes)')

    print('\nAll icons generated successfully!')

if __name__ == '__main__':
    main()
