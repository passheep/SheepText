# /// script
# requires-python = ">=3.11"
# dependencies = ["pillow>=11,<13"]
# ///
"""从用户指定 PNG 同步 Windows、托盘及应用内图标，不删除旧文件。"""
from pathlib import Path
import argparse
import shutil
from PIL import Image, ImageOps


def main():
    """保留原图透明度与比例，输出多尺寸 ICO 和 PNG。"""
    parser = argparse.ArgumentParser(description="更新 SheepText 图标资源")
    parser.add_argument("source", type=Path, help="用户提供的 PNG 图标")
    args = parser.parse_args()
    root = Path(__file__).resolve().parents[1]
    resources = root / "resources"
    with Image.open(args.source) as original:
        image = original.convert("RGBA")
        print(f"输入尺寸：{image.size}，透明通道范围：{image.getchannel('A').getextrema()}")
        side = max(image.size)
        canvas = Image.new("RGBA", (side, side), (0, 0, 0, 0))
        canvas.paste(image, ((side - image.width) // 2, (side - image.height) // 2))
        shutil.copyfile(args.source, resources / "icon-source.png")
        canvas.save(resources / "icon.png")
        canvas.save(root / "src/renderer/src/assets/app-icon.png")
        icon = ImageOps.contain(canvas, (256, 256), Image.Resampling.LANCZOS)
        icon.save(resources / "icon.ico", format="ICO", sizes=[(n, n) for n in (16, 20, 24, 32, 40, 48, 64, 128, 256)])
        canvas.resize((32, 32), Image.Resampling.LANCZOS).save(resources / "tray.png")
    with Image.open(resources / "icon.ico") as result:
        print(f"ICO 尺寸：{sorted(result.ico.sizes())}")
    print("图标资源已同步；输入原图未修改。")


if __name__ == "__main__":
    main()
