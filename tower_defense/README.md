# Tower Defense Game - Python + Bonescript Backend

A 2D tower defense game built with Python/Pygame featuring a bonescript-style REST API backend.

## Project Structure

```
tower_defense/
├── __init__.py          # Package init
├── models.py            # Data models (GameState, Tower, Enemy, etc.)
├── game_engine.py       # Core game logic engine
├── server.py            # REST API server (bonescript-compatible endpoints)
├── game.py              # Pygame renderer & main game loop
└── requirements.txt     # Python dependencies
```

## Features

- **4 Tower Types**: Arrow, Cannon, Magic, Ice - each with unique stats
- **4 Enemy Types**: Basic, Fast, Tank, Boss - with varying health and speed
- **6 Waves** of increasing difficulty
- **Tower Management**: Place, upgrade (3x), and sell towers
- **Scoring System**: Earn gold by defeating enemies
- **REST API Backend**: bonescript-compatible endpoints matching the .bone model

## Installation

```bash
cd tower_defense
pip install -r requirements.txt
# or manually:
pip install pygame requests
```

## Running

### Play the Game (Pygame GUI)
```bash
python -m tower_defense.game
```

### Start API Server
```bash
python -m tower_defense.server
# Runs on http://localhost:8000
```

## API Endpoints

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/api/game/state` | Get current game state |
| POST | `/api/game/action` | Perform game action (startGame, placeTower, upgradeTower, sellTower, startWave, pauseGame, resumeGame) |
| GET | `/api/highscores` | Get top 10 high scores |
| POST | `/api/highscore` | Submit a new high score |

### Example API Calls

```bash
# Start a new game
curl -X POST http://localhost:8000/api/game/action \
  -H "Content-Type: application/json" \
  -d '{"action": "startGame"}'

# Place an arrow tower
curl -X POST http://localhost:8000/api/game/action \
  -H "Content-Type: application/json" \
  -d '{"action": "placeTower", "towerType": "arrow", "x": 200, "y": 300}'

# Start the first wave
curl -X POST http://localhost:8000/api/game/action \
  -H "Content-Type: application/json" \
  -d '{"action": "startWave"}'
```

## Game Controls (Pygame GUI)

- **Left Click** on tower type buttons to select tower
- **Right Click** on the map to place selected tower
- **P** key to pause/resume game
- **R** key to restart after game over/victory

## Tower Stats

| Type | Cost | Damage | Range | Fire Rate | Special |
|------|------|--------|-------|-----------|---------|
| Arrow | 50g | 20 | 120px | 1.5/s | Balanced |
| Cannon | 100g | 35 | 100px | 0.8/s | High damage |
| Magic | 150g | 25 | 140px | 1.2/s | Long range |
| Ice | 120g | 15 | 90px | 1.0/s | Slows enemies |

## Enemy Stats

| Type | Health | Speed | Reward |
|------|--------|-------|--------|
| Basic | 50 | Medium | 10g |
| Fast | 30 | High | 15g |
| Tank | 150 | Low | 25g |
| Boss | 500 | Very Low | 100g |

## Architecture

The game follows a clean separation of concerns:

1. **Models** (`models.py`) - Data structures matching the bonescript .bone definitions
2. **Game Engine** (`game_engine.py`) - Pure logic, no rendering dependencies
3. **Server** (`server.py`) - REST API layer connecting to the engine
4. **Game** (`game.py`) - Pygame rendering and user input

This mirrors the bonescript pattern where models define the data contract, and separate components handle business logic and presentation.
