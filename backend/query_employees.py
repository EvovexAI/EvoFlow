import sys, os
sys.path.insert(0, os.path.join(os.path.dirname(__file__), 'packages', 'harness'))
os.chdir(os.path.join(os.path.dirname(__file__), 'packages', 'harness'))

from evoflow.admin import employees as emp_admin

result = emp_admin.list_roles()
roles = result.get('roles', [])
print(f"Total roles: {result.get('count', 0)}")
print(f"Active: {result.get('active_count', 0)}, Busy: {result.get('busy_count', 0)}, Pending: {result.get('pending_approvals', 0)}")
print()
for r in roles:
    code = r.get('agent_code', '')
    name = r.get('role_name', '')
    dept = r.get('department', '')
    status = r.get('status', '')
    org_key = r.get('org_key', '')
    empty_name = ' *** EMPTY NAME ***' if not name else ''
    print(f"  [{status:8}] code={code!r:45s}  role_name={name!r:30s}  dept={dept!r:20s}  org_key={org_key!r}{empty_name}")

# Also show which ones have empty names
print()
empty_names = [r for r in roles if not r.get('role_name')]
print(f"Roles with empty/None role_name: {len(empty_names)}")
for r in empty_names:
    print(f"  agent_code={r.get('agent_code')!r}, role_name={r.get('role_name')!r}")
