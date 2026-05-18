"""
Tower Defense Game Engine - Core Game Logic
Handles game state, enemy spawning, tower targeting, projectile physics
"""
import random
from typing import List, Dict, Any, Optional
from models import (
    GameState, Tower, Enemy, Projectile, Wave, Position, HighScore
)


class GameEngine:
    def __init__(self):
        self.state = GameState()
        self.high_scores: List[HighScore] = []
        self._generate_waves()
    
    def _generate_waves(self):
        """Generate wave patterns for the game"""
        wave_configs = [
            {"enemies": [{"type": "basic", "count": 5}], "interval": 1.0},
            {"enemies": [{"type": "basic", "count": 8}, {"type": "fast", "count": 3}], "interval": 0.8},
            {"enemies": [{"type": "fast", "count": 10}], "interval": 0.6},
            {"enemies": [{"type": "basic", "count": 5}, {"type": "tank", "count": 3}], "interval": 0.9},
            {"enemies": [{"type": "fast", "count": 8}, {"type": "tank", "count": 5}], "interval": 0.7},
            {"enemies": [{"type": "boss", "count": 1}], "interval": 2.0},
        ]
        
        for i, config in enumerate(wave_configs):
            wave = Wave(
                id=i + 1,
                enemies=config["enemies"],
                spawn_interval=config["interval"]
            )
            self.state.waves.append(wave)
    
    def start_game(self) -> GameState:
        """Initialize a new game"""
        self.state = GameState()
        self._generate_waves()
        return self.state
    
    def place_tower(self, tower_type: str, x: float, y: float) -> Optional[GameState]:
        """Place a tower on the map"""
        if self.state.gold < 50:
            return self.state
        
        cost_map = {"arrow": 50, "cannon": 100, "magic": 150, "ice": 120}
        range_map = {"arrow": 120, "cannon": 100, "magic": 140, "ice": 90}
        damage_map = {"arrow": 20, "cannon": 35, "magic": 25, "ice": 15}
        rate_map = {"arrow": 1.5, "cannon": 0.8, "magic": 1.2, "ice": 1.0}
        
        cost = cost_map.get(tower_type, 50)
        
        if self.state.gold < cost:
            return self.state
        
        tower = Tower(
            id=f"tower_{len(self.state.towers) + 1}",
            name=f"{tower_type.capitalize()} Tower",
            tower_type=tower_type,
            position=Position(x=x, y=y),
            range=range_map.get(tower_type, 100),
            damage=damage_map.get(tower_type, 10),
            fire_rate=rate_map.get(tower_type, 1.0),
            cost=cost,
            level=1
        )
        
        self.state.towers.append(tower)
        self.state.gold -= cost
        
        return self.state
    
    def upgrade_tower(self, tower_id: str) -> Optional[GameState]:
        """Upgrade an existing tower"""
        tower = next((t for t in self.state.towers if t.id == tower_id), None)
        if not tower:
            return self.state
        
        upgrade_cost = int(tower.cost * 0.75 * tower.level)
        if self.state.gold < upgrade_cost:
            return self.state
        
        self.state.gold -= upgrade_cost
        tower.level += 1
        tower.damage *= 1.3
        tower.range *= 1.1
        
        return self.state
    
    def sell_tower(self, tower_id: str) -> Optional[GameState]:
        """Sell a tower for partial refund"""
        tower = next((t for t in self.state.towers if t.id == tower_id), None)
        if not tower:
            return self.state
        
        refund = int(tower.cost * 0.5)
        self.state.gold += refund
        self.state.towers.remove(tower)
        
        return self.state
    
    def start_wave(self) -> Optional[GameState]:
        """Start the next wave"""
        if self.state.wave >= len(self.state.waves):
            self.state.game_status = "victory"
            return self.state
        
        wave = self.state.waves[self.state.wave]
        
        for enemy_config in wave.enemies:
            for _ in range(enemy_config["count"]):
                enemy_type = enemy_config["type"]
                health_map = {"basic": 50, "fast": 30, "tank": 150, "boss": 500}
                speed_map = {"basic": 40, "fast": 80, "tank": 25, "boss": 20}
                reward_map = {"basic": 10, "fast": 15, "tank": 25, "boss": 100}
                
                enemy = Enemy(
                    id=f"enemy_{len(self.state.enemies) + 1}",
                    name=f"{enemy_type.capitalize()} Enemy",
                    enemy_type=enemy_type,
                    position=Position(x=800, y=random.randint(50, 550)),
                    path_index=0,
                    health=health_map.get(enemy_type, 50),
                    max_health=health_map.get(enemy_type, 50),
                    speed=speed_map.get(enemy_type, 40),
                    reward=reward_map.get(enemy_type, 10)
                )
                self.state.enemies.append(enemy)
        
        self.state.wave += 1
        return self.state
    
    def update(self, dt: float) -> GameState:
        """Update game state"""
        if self.state.game_status != "playing":
            return self.state
        
        # Update enemies movement
        for enemy in self.state.enemies[:]:
            if not enemy.is_alive:
                continue
            
            # Move left toward base
            enemy.position.x -= enemy.speed * dt
            
            # Check if reached base
            if enemy.position.x <= 0:
                self.state.lives -= 1
                self.state.enemies.remove(enemy)
                
                if self.state.lives <= 0:
                    self.state.game_status = "gameover"
                continue
        
        # Update tower firing
        for tower in self.state.towers[:]:
            # Find target
            targets = [e for e in self.state.enemies 
                      if e.is_alive and 
                      tower.position.distance_to(e.position) <= tower.range]
            
            if targets:
                # Fire at closest target
                target = min(targets, key=lambda e: tower.position.distance_to(e.position))
                
                # Create projectile
                dx = target.position.x - tower.position.x
                dy = target.position.y - tower.position.y
                dist = math.sqrt(dx**2 + dy**2) if (dx**2 + dy**2) > 0 else 1
                
                velocity_x = (dx / dist) * 300
                velocity_y = (dy / dist) * 300
                
                projectile = Projectile(
                    id=f"proj_{len(self.state.projectiles) + 1}",
                    tower_id=tower.id,
                    target_id=target.id,
                    position=Position(x=tower.position.x, y=tower.position.y),
                    velocity_x=velocity_x,
                    velocity_y=velocity_y,
                    damage=tower.get_total_damage(),
                    projectile_type=tower.tower_type
                )
                
                self.state.projectiles.append(projectile)
        
        # Update projectiles
        for projectile in self.state.projectiles[:]:
            projectile.position.x += projectile.velocity_x * dt
            projectile.position.y += projectile.velocity_y * dt
            
            # Check collision with enemies
            for enemy in self.state.enemies[:]:
                if not enemy.is_alive:
                    continue
                
                dist = projectile.position.distance_to(enemy.position)
                if dist < 20:  # Hit radius
                    enemy.health -= projectile.damage
                    
                    # Apply special effects based on tower type
                    if projectile.projectile_type == "ice":
                        enemy.frozen = True
                        enemy.freeze_timer = 2.0
                        enemy.speed *= 0.5
                    
                    if enemy.health <= 0:
                        self.state.gold += enemy.reward
                        self.state.score += enemy.reward
                        self.state.enemies.remove(enemy)
                    
                    if projectile.id in [p.id for p in self.state.projectiles]:
                        self.state.projectiles.remove(projectile)
                    break
        
        # Update freeze timers
        for enemy in self.state.enemies:
            if enemy.frozen and enemy.freeze_timer > 0:
                enemy.freeze_timer -= dt
                if enemy.freeze_timer <= 0:
                    enemy.frozen = False
                    # Restore original speed (simplified)
        
        return self.state
    
    def add_high_score(self, player_name: str, score: int, level: int) -> HighScore:
        """Add a high score entry"""
        hs = HighScore(
            player_name=player_name,
            score=score,
            level=level
        )
        self.high_scores.append(hs)
        self.high_scores.sort(key=lambda x: x.score, reverse=True)
        return hs
    
    def get_high_scores(self) -> List[HighScore]:
        """Get top 10 high scores"""
        return sorted(self.high_scores, key=lambda x: x.score, reverse=True)[:10]
