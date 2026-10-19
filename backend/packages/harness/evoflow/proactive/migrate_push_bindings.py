#!/usr/bin/env python3
"""Migrate push config from evoflow_proactive_roles.config_json to evoflow_role_push_bindings.

Run this after schema upgrade.
"""

import sqlite3
import json
import sys
from datetime import datetime

def migrate_push_bindings(db_path: str) -> None:
    """Migrate existing push config to new table."""
    conn = sqlite3.connect(db_path)
    conn.row_factory = sqlite3.Row
    
    print(f"Connecting to {db_path}...")
    
    # Ensure table exists
    cur = conn.cursor()
    print("Creating evoflow_role_push_bindings table if not exists...")
    cur.execute("""
        CREATE TABLE IF NOT EXISTS evoflow_role_push_bindings (
            agent_code TEXT PRIMARY KEY,
            push_enabled INTEGER NOT NULL DEFAULT 1,
            push_channels TEXT NOT NULL DEFAULT 'feishu',
            feishu_open_id TEXT NOT NULL DEFAULT '',
            feishu_chat_id TEXT NOT NULL DEFAULT '',
            feishu_user_id TEXT NOT NULL DEFAULT '',
            feishu_target_type TEXT NOT NULL DEFAULT 'open_id',
            feishu_verified_at TEXT,
            wecom_bot_id TEXT NOT NULL DEFAULT '',
            wecom_verified_at TEXT,
            slack_channel_id TEXT NOT NULL DEFAULT '',
            slack_verified_at TEXT,
            email TEXT NOT NULL DEFAULT '',
            created_at TEXT NOT NULL,
            updated_at TEXT NOT NULL,
            FOREIGN KEY (agent_code) REFERENCES evoflow_proactive_roles(agent_code) ON DELETE CASCADE
        );
    """)
    conn.commit()
    
    # Get all roles
    cur = conn.cursor()
    cur.execute("SELECT agent_code, config_json FROM evoflow_proactive_roles ORDER BY agent_code")
    roles = cur.fetchall()
    
    now = datetime.now(datetime.UTC).isoformat() if hasattr(datetime, 'UTC') else datetime.utcnow().isoformat() + "Z"
    migrated = 0
    skipped = 0
    
    print(f"\nMigrating {len(roles)} roles...\n")
    
    for role in roles:
        agent_code = role['agent_code']
        
        # Parse config
        cfg = {}
        if role['config_json']:
            try:
                cfg = json.loads(role['config_json'])
            except:
                cfg = {}
        
        # Extract push config
        feishu_oid = (cfg.get('feishu_open_id') or '').strip()
        feishu_appid = (cfg.get('feishu_app_id') or '').strip()
        feishu_secret = (cfg.get('feishu_app_secret') or '').strip()
        push_enabled = 'feishu' in (cfg.get('approval_channels') or [])
        
        # Determine target type and id
        feishu_target_type = 'open_id'
        feishu_target_id = feishu_oid
        
        # Check if there's any binding
        has_binding = bool(feishu_oid.strip())
        
        # Determine if we should enable push
        # Only enable if: approval_channels includes 'feishu' AND has a binding
        should_enable_push = push_enabled and has_binding
        
        # Insert or update binding
        cur.execute("""
            INSERT OR REPLACE INTO evoflow_role_push_bindings (
                agent_code, push_enabled, push_channels,
                feishu_open_id, feishu_chat_id, feishu_user_id, feishu_target_type,
                created_at, updated_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        """, (
            agent_code,
            1 if should_enable_push else 0,
            'feishu' if should_enable_push else '',
            feishu_target_id if feishu_target_type == 'open_id' else '',
            '',  # feishu_chat_id
            '',  # feishu_user_id
            feishu_target_type,
            now,
            now,
        ))
        
        status = "OK" if should_enable_push else "  "
        print(f"  {status} {agent_code:35s} | push={'enabled' if should_enable_push else 'disabled'}")
        
        if should_enable_push:
            migrated += 1
        else:
            skipped += 1
    
    conn.commit()
    print(f"\nMigration complete!")
    print(f"  Migrated (with active push): {migrated}")
    print(f"  Skipped (no binding or disabled): {skipped}")
    conn.close()

if __name__ == '__main__':
    db_path = sys.argv[1] if len(sys.argv) > 1 else r'C:\Users\admin\.evoflow-dev\data\app\evoflow.db'
    migrate_push_bindings(db_path)
