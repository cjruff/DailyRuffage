# Regenerates the app's images from the two masters in /art. Run from the repo root:
#   python tools/make_icons.py
# art/home-icon.png  -> home-screen icon, favicon   (best: simple, readable when tiny)
# art/brand-art.png  -> in-app artwork (header avatar, Settings)
# Needs Pillow: pip install pillow
# Code: © Corey J Ruff
from PIL import Image
home = Image.open('art/home-icon.png').convert('RGB')
side = min(home.size)
home = home.crop(((home.width - side) // 2, (home.height - side) // 2, (home.width + side) // 2, (home.height + side) // 2))
for n in (180, 192, 512):
    home.resize((n, n), Image.LANCZOS).save(f'app/icons/icon-{n}.png', optimize=True)
home.resize((64, 64), Image.LANCZOS).save('app/icons/favicon.png', optimize=True)
brand = Image.open('art/brand-art.png').convert('RGB')
brand.thumbnail((800, 800), Image.LANCZOS)
brand.save('app/icons/brand-art.jpg', quality=85, optimize=True)
print('Icons updated. Bump VERSION in app/sw.js so phones pick them up.')
