"""
YouSum 打包脚本

生成 yousum-extension-test.zip（纯扩展文件，可直接加载测试）。
只包含 manifest.json / background / content / icons，不含 Worker、测试和文档。

用法：
    python tools/build.py
"""

import os
import zipfile

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
OUT = os.path.join(os.path.dirname(ROOT), "yousum-extension-test.zip")

# 只打包这些运行时文件
INCLUDE = ["manifest.json", "background", "content", "icons"]

# 这些目录/文件即使在 INCLUDE 路径下也要排除
EXCLUDE_NAMES = {"test", "tests", "__pycache__", ".DS_Store", "node_modules"}
EXCLUDE_SUFFIX = (".test.mjs", ".map")


def collect():
    files = []
    for item in INCLUDE:
        path = os.path.join(ROOT, item)
        if not os.path.exists(path):
            continue
        if os.path.isfile(path):
            files.append(path)
            continue
        for dirpath, dirnames, filenames in os.walk(path):
            dirnames[:] = [d for d in dirnames if d not in EXCLUDE_NAMES]
            for f in filenames:
                if f in EXCLUDE_NAMES or f.endswith(EXCLUDE_SUFFIX):
                    continue
                files.append(os.path.join(dirpath, f))
    return files


def main():
    files = collect()
    if os.path.exists(OUT):
        os.remove(OUT)

    with zipfile.ZipFile(OUT, "w", zipfile.ZIP_DEFLATED, compresslevel=9) as z:
        for full in files:
            arc = os.path.relpath(full, ROOT).replace("\\", "/")
            z.write(full, arc)

    size = os.path.getsize(OUT)
    print(f"打包完成: {OUT}")
    print(f"文件数: {len(files)}   大小: {size / 1024:.1f} KB\n")
    with zipfile.ZipFile(OUT) as z:
        for i in z.infolist():
            print(f"  {i.filename:36s} {i.file_size:>8d}")

    # 校验 manifest 在包内且可解析
    with zipfile.ZipFile(OUT) as z:
        import json

        m = json.loads(z.read("manifest.json"))
        assert m["manifest_version"] == 3, "manifest_version 必须为 3"
        for key in ("background", "content_scripts", "icons"):
            assert key in m, f"manifest 缺少 {key}"
    print("\nmanifest 校验通过")


if __name__ == "__main__":
    main()
