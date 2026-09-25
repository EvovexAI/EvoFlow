#!/usr/bin/env python3
"""Debug script to check EVOFLOW_HOME resolution."""
import os
from pathlib import Path

# Check environment variable
evoflow_home = os.getenv("EVOFLOW_HOME")
print(f"EVOFLOW_HOME from env: {evoflow_home}")

# Check directories
home = Path.home()
evoflow_dir = home / ".evoflow"
evoflow_dev_dir = home / ".evoflow-dev"

print(f"User home: {home}")
print(f".evoflow exists: {evoflow_dir.exists()}")
print(f".evoflow-dev exists: {evoflow_dev_dir.exists()}")

# Test the actual resolution logic from evoflow
try:
    import sys
    sys.path.insert(0, str(Path(__file__).parent.parent / "backend" / "packages" / "harness"))
    
    from evoflow.config.paths import get_paths
    
    paths = get_paths()
    print(f"\nResolved base_dir: {paths.base_dir}")
    print(f"Resolved evoflow_db: {paths.evoflow_db}")
except Exception as e:
    print(f"Error loading evoflow paths: {e}")
    import traceback
    traceback.print_exc()
