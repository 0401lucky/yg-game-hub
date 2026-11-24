"""从第三方生图的 3×2 原图生成牌面插画。原图保留，便于再次调整。"""
from pathlib import Path
from PIL import Image

assets = Path(__file__).resolve().parents[1] / "games" / "doudizhu" / "assets"
with Image.open(assets / "card-characters.png") as sheet:
    width, height = sheet.size
    for index, name in enumerate(["king", "queen", "jack", "joker-green", "joker-red", "raven"]):
        column, row = index % 3, index // 3
        box = (round(column * width / 3), round(row * height / 2),
               round((column + 1) * width / 3), round((row + 1) * height / 2))
        portrait = sheet.crop(box).resize((384, 384), Image.Resampling.LANCZOS)
        portrait.save(assets / f"{name}.webp", "WEBP", quality=90, method=6)
        print(f"Saved {name}.webp")
