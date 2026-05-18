"""
Tower Defense REST API Server - Bonescript Backend Style
Provides endpoints matching the .bone model definitions
"""
from http.server import HTTPServer, BaseHTTPRequestHandler
import json
from game_engine import GameEngine


class TowerDefenseAPI(BaseHTTPRequestHandler):
    engine = None
    
    def send_json(self, data: dict, status: int = 200):
        self.send_response(status)
        self.send_header('Content-Type', 'application/json')
        self.end_headers()
        self.wfile.write(json.dumps(data, default=str).encode())
    
    def do_GET(self):
        if self.path == '/api/game/state':
            state = self.engine.state
            self.send_json({
                "id": state.id,
                "level": state.level,
                "gold": state.gold,
                "lives": state.lives,
                "score": state.score,
                "wave": state.wave,
                "towers": [{"id": t.id, "type": t.tower_type, 
                           "position": {"x": t.position.x, "y": t.position.y},
                           "range": t.range, "damage": t.damage,
                           "level": t.level} for t in state.towers],
                "enemies": [{"id": e.id, "type": e.enemy_type,
                            "position": {"x": e.position.x, "y": e.position.y},
                            "health": e.health, "maxHealth": e.max_health} 
                           for e in state.enemies],
                "gameStatus": state.game_status,
                "waves": [{"id": w.id, "enemies": w.enemies, 
                          "spawnInterval": w.spawn_interval} 
                         for w in state.waves]
            })
        
        elif self.path == '/api/highscores':
            scores = self.engine.get_high_scores()
            self.send_json([{
                "id": s.id,
                "playerName": s.player_name,
                "score": s.score,
                "level": s.level,
                "date": s.date
            } for s in scores])
        
        elif self.path == '/':
            self.send_json({"status": "ok", "message": "Tower Defense API"})
    
    def do_POST(self):
        content_length = int(self.headers.get('Content-Length', 0))
        body = json.loads(self.rfile.read(content_length).decode()) if content_length > 0 else {}
        
        action = body.get('action')
        
        if action == 'startGame':
            result = self.engine.start_game()
            self.send_json({
                "id": result.id, "level": result.level, "gold": result.gold,
                "lives": result.lives, "score": result.score, "wave": result.wave,
                "gameStatus": result.game_status
            })
        
        elif action == 'placeTower':
            result = self.engine.place_tower(
                body.get('towerType', 'arrow'),
                float(body.get('x', 100)),
                float(body.get('y', 300))
            )
            self.send_json({
                "gold": result.gold, "towers": len(result.towers),
                "gameStatus": result.game_status
            })
        
        elif action == 'upgradeTower':
            result = self.engine.upgrade_tower(body.get('towerId', ''))
            self.send_json({
                "gold": result.gold, "score": result.score,
                "gameStatus": result.game_status
            })
        
        elif action == 'sellTower':
            result = self.engine.sell_tower(body.get('towerId', ''))
            self.send_json({
                "gold": result.gold, "towers": len(result.towers),
                "gameStatus": result.game_status
            })
        
        elif action == 'startWave':
            result = self.engine.start_wave()
            self.send_json({
                "wave": result.wave, "enemies": len(result.enemies),
                "lives": result.lives, "gameStatus": result.game_status
            })
        
        elif action == 'pauseGame':
            self.engine.state.game_status = 'paused'
            self.send_json({"gameStatus": "paused"})
        
        elif action == 'resumeGame':
            self.engine.state.game_status = 'playing'
            self.send_json({"gameStatus": "playing"})
        
        elif action == 'highscore':
            hs = self.engine.add_high_score(
                body.get('playerName', 'Player'),
                int(body.get('score', 0)),
                int(body.get('level', 1))
            )
            self.send_json({
                "id": hs.id, "playerName": hs.player_name,
                "score": hs.score, "date": hs.date
            })


def run_server(port=8000):
    """Start the API server"""
    TowerDefenseAPI.engine = GameEngine()
    server = HTTPServer(('localhost', port), TowerDefenseAPI)
    print(f"Tower Defense API running on http://localhost:{port}")
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\nShutting down server...")
        server.server_close()


if __name__ == '__main__':
    run_server()
