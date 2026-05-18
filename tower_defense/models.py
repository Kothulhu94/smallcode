"""
Tower Defense Game Models - Bonescript Backend Data Structures
"""
from dataclasses import dataclass, field
from typing import List, Optional, Dict, Any
import uuid
import math


@dataclass
class Position:
    x: float = 0.0
    y: float = 0.0
    
    def distance_to(self, other: 'Position') -> float:
        return math.sqrt((self.x - other.x) ** 2 + (self.y - other.y) ** 2)


@dataclass
class Tower:
    id: str = ""
    name: str = ""
    tower_type: str = "arrow"  # arrow, cannon, magic, ice
    position: Position = field(default_factory=Position)
    range: float = 100.0
    damage: float = 10.0
    fire_rate: float = 1.0  # attacks per second
    cost: int = 50
    level: int = 1
    
    def get_total_damage(self) -> float:
        return self.damage * self.level


@dataclass
class Enemy:
    id: str = ""
    name: str = ""
    enemy_type: str = "basic"  # basic, fast, tank, boss
    position: Position = field(default_factory=Position)
    path_index: int = 0
    health: float = 100.0
    max_health: float = 100.0
    speed: float = 50.0  # pixels per second
    reward: int = 10
    frozen: bool = False
    freeze_timer: float = 0.0
    
    @property
    def is_alive(self) -> bool:
        return self.health > 0


@dataclass
class Projectile:
    id: str = ""
    tower_id: str = ""
    target_id: str = ""
    position: Position = field(default_factory=Position)
    velocity_x: float = 0.0
    velocity_y: float = 0.0
    damage: float = 10.0
    projectile_type: str = "arrow"


@dataclass
class Wave:
    id: int = 0
    enemies: List[Dict[str, Any]] = field(default_factory=list)
    spawn_interval: float = 1.0


@dataclass
class GameState:
    id: str = ""
    level: int = 1
    gold: int = 200
    lives: int = 20
    score: int = 0
    wave: int = 0
    towers: List[Tower] = field(default_factory=list)
    enemies: List[Enemy] = field(default_factory=list)
    projectiles: List[Projectile] = field(default_factory=list)
    waves: List[Wave] = field(default_factory=list)
    game_status: str = "menu"  # menu, playing, paused, gameover, victory
    start_time: float = 0.0
    
    @property
    def is_game_over(self) -> bool:
        return self.lives <= 0 or self.game_status == 'gameover'


@dataclass
class HighScore:
    id: str = ""
    player_name: str = ""
    score: int = 0
    level: int = 1
    date: Optional[str] = None
    
    def __post_init__(self):
        if not self.id:
            self.id = str(uuid.uuid4())[:8]
        if not self.date:
            from datetime import datetime
            self.date = datetime.now().isoformat()
