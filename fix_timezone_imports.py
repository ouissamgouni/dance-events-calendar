#!/usr/bin/env python3
"""Fix timezone imports in all backend files."""

import re
from pathlib import Path

# Find all Python files in backend (excluding tests)
backend_path = Path("backend")
files_fixed = 0

for py_file in backend_path.rglob("*.py"):
    if "/tests/" not in str(py_file):
        with open(py_file, "r") as f:
            content = f.read()

        if "datetime.now(timezone" in content or "timezone.utc" in content:
            if "from datetime import" in content and "timezone" not in content:
                # Add timezone to the from-import
                new_content = re.sub(
                    r"(from datetime import [^\n]+?)(?=\n)",
                    lambda m: (
                        m.group(1) + ", timezone"
                        if "timezone" not in m.group(1)
                        else m.group(1)
                    ),
                    content,
                )

                if new_content != content:
                    with open(py_file, "w") as f:
                        f.write(new_content)
                    files_fixed += 1
                    print(f"✓ Fixed {py_file}")

print(f"\nTotal files fixed: {files_fixed}")
