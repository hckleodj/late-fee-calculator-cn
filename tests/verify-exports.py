"""Inspect actual browser downloads; requires Pillow and pypdf."""
import json
import re
from pathlib import Path
from PIL import Image, ImageChops
from pypdf import PdfReader

root = Path(__file__).resolve().parents[1] / 'output' / 'acceptance'
report = []
for name, expected_pages in [('A', 1), ('B', 1), ('C', 1), ('D', 1), ('E60', 2), ('F120', 4)]:
    reader = PdfReader(root / f'{name}.pdf')
    png = Image.open(root / f'{name}.png').convert('RGB')
    assert len(reader.pages) == expected_pages
    assert png.width == 1588
    used_images = []
    for index, page in enumerate(reader.pages):
        # jsPDF shares the resources dictionary across pages; inspect the actual Do operator.
        names = re.findall(rb'/([A-Za-z0-9]+)\s+Do', page.get_contents().get_data())
        assert len(names) == 1
        image = next(item.image.convert('RGB') for item in page.images if item.name == names[0].decode() + '.png')
        assert image.width == 1588
        used_images.append(names[0].decode())
        if expected_pages == 1:
            assert image.size == png.size
            assert ImageChops.difference(image, png).getbbox() is None, name
    assert len(set(used_images)) == expected_pages
    report.append({'case': name, 'pages': expected_pages, 'pngPixels': png.size, 'pngPdfPixelIdentical': True if expected_pages == 1 else 'paginated, different page furniture'})
(root / 'export-verification.json').write_text(json.dumps(report, indent=2))
print(json.dumps(report, indent=2))
