---
name: home-assistant
description: Control smart home devices and query sensor states via Home Assistant. Use for lights, switches, climate, locks, covers, media players, and any other entity. Also use to run scenes, scripts, and automations.
allowed-tools: Bash(curl:*)
---

# Home Assistant Control

Credentials are available as environment variables:
- `$HA_URL` — e.g. `http://homeassistant.local:8123`
- `$HA_TOKEN` — Long-Lived Access Token

## List all entities

```bash
curl -s -H "Authorization: Bearer $HA_TOKEN" "$HA_URL/api/states" | \
  jq '[.[] | {entity_id, state, friendly_name: .attributes.friendly_name}]'
```

## Get a single entity state

```bash
curl -s -H "Authorization: Bearer $HA_TOKEN" "$HA_URL/api/states/light.living_room"
```

## Call a service (control a device)

```bash
# Turn on a light
curl -s -X POST \
  -H "Authorization: Bearer $HA_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"entity_id": "light.living_room"}' \
  "$HA_URL/api/services/light/turn_on"

# Turn off a switch
curl -s -X POST \
  -H "Authorization: Bearer $HA_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"entity_id": "switch.kitchen_fan"}' \
  "$HA_URL/api/services/switch/turn_off"

# Set light brightness and color temp
curl -s -X POST \
  -H "Authorization: Bearer $HA_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"entity_id": "light.bedroom", "brightness_pct": 40, "kelvin": 2700}' \
  "$HA_URL/api/services/light/turn_on"

# Set thermostat temperature
curl -s -X POST \
  -H "Authorization: Bearer $HA_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"entity_id": "climate.living_room", "temperature": 72}' \
  "$HA_URL/api/services/climate/set_temperature"

# Lock/unlock a lock
curl -s -X POST \
  -H "Authorization: Bearer $HA_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"entity_id": "lock.front_door"}' \
  "$HA_URL/api/services/lock/lock"

# Run a scene
curl -s -X POST \
  -H "Authorization: Bearer $HA_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"entity_id": "scene.movie_time"}' \
  "$HA_URL/api/services/scene/turn_on"

# Run a script
curl -s -X POST \
  -H "Authorization: Bearer $HA_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{}' \
  "$HA_URL/api/services/script/good_morning_routine"

# Trigger an automation
curl -s -X POST \
  -H "Authorization: Bearer $HA_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"entity_id": "automation.bedtime"}' \
  "$HA_URL/api/services/automation/trigger"
```

## Common service domains

| Domain | Actions |
|--------|---------|
| `light` | `turn_on`, `turn_off`, `toggle` |
| `switch` | `turn_on`, `turn_off`, `toggle` |
| `climate` | `set_temperature`, `set_hvac_mode`, `turn_on`, `turn_off` |
| `lock` | `lock`, `unlock` |
| `cover` | `open_cover`, `close_cover`, `stop_cover` |
| `media_player` | `turn_on`, `turn_off`, `play_media`, `volume_set` |
| `scene` | `turn_on` |
| `script` | `turn_on` or `/{script_id}` |
| `automation` | `trigger`, `turn_on`, `turn_off` |
| `input_boolean` | `turn_on`, `turn_off`, `toggle` |

## Find entity IDs

If unsure of an entity ID, list all entities and filter:

```bash
curl -s -H "Authorization: Bearer $HA_TOKEN" "$HA_URL/api/states" | \
  jq '[.[] | select(.entity_id | contains("living")) | {entity_id, state}]'
```

## Check if HA is reachable

```bash
curl -s -H "Authorization: Bearer $HA_TOKEN" "$HA_URL/api/" | jq .
```
