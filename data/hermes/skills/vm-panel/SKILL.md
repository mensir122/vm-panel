---
name: vm-panel
description: Manage and inspect VM-Panel, host system resources, projects, services, and deployments using vmctl and the local Manager API.
---

# VM-Panel Management Skill

Use this skill when interacting with the host VM-Panel system, checking server health and resources, managing services, and deploying projects.

## Architecture Context
- **System**: VM-Panel (Fresh, zero-hardcode, ESM Node >= 20, SQLite).
- **Manager API**: Running locally at `http://127.0.0.1:8097` (secured with Bearer token in `runtime/sockets/cli-token`).
- **Web Panel**: Running locally at `http://127.0.0.1:8080`.
- **9Router**: Running locally at `http://127.0.0.1:20127` (LLM gateway).
- **CLI Tool**: `node bin/vmctl.js <noun> <verb> [args]` in the workspace root.

---

## Key CLI Commands (`node bin/vmctl.js`)

Always execute commands with relative path `node bin/vmctl.js` from the workspace root (`c:\Users\anjal\Documents\VM-Panel` or current directory).

### 1. System & Health
```bash
# Check system status, host specs, CPU, RAM, disk, and uptime:
node bin/vmctl.js system status

# Quick health probe:
node bin/vmctl.js health
```

### 2. Services Management
```bash
# List all active/configured services:
node bin/vmctl.js service list

# Get detailed info or status of a specific service:
node bin/vmctl.js service status <service_id>

# Check health of a specific service:
node bin/vmctl.js service health <service_id>

# Restart a service:
node bin/vmctl.js service restart <service_id>

# View recent service logs:
node bin/vmctl.js service logs <service_id>
```

### 3. Projects Management
```bash
# List all registered projects:
node bin/vmctl.js project list

# Create a new project:
node bin/vmctl.js project create --name <project_name> --type <node|python|static> --port <port_number>

# Deploy a project:
node bin/vmctl.js project deploy <project_id>

# View project status:
node bin/vmctl.js project status <project_id>
```

### 4. Deployments & Backups
```bash
# List recent deployments:
node bin/vmctl.js deployment list --limit 10

# Show deployment details and events:
node bin/vmctl.js deployment show <deployment_id>

# List backups:
node bin/vmctl.js backup list --limit 5

# Create a manual backup:
node bin/vmctl.js backup create
```

---

## Safety Rules & Guidelines
1. **Destructive Actions**: Operations like `project remove`, `service remove`, `purge`, or `rollback` require two-phase confirmation (typing the target ID). Never run destructive commands without explicit confirmation from the user.
2. **Secrets Protection**: Never print, expose, or log secret keys, tokens, or credentials.
3. **Responses**: Present status, resource metrics, and service states clearly using markdown tables and bullet points.
