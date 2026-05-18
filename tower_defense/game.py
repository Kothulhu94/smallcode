"""
Tower Defense Game - Main Pygame Renderer
2D visual interface for the Tower Defense game
"""
import pygame
import sys
import math
from models import GameState, Tower, Enemy, Projectile


class TowerDefenseGame:
    def __init__(self):
        self.width = 800
        self.height = 600
        self.screen = pygame.display.set_mode((self.width, self.height))
        pygame.display.set_caption("Tower Defense Game")
        self.clock = pygame.time.Clock()
        
        # Colors
        self.colors = {
            'background': (30, 30, 50),
            'grid': (40, 40, 60),
            'arrow': (139, 69, 19),
            'cannon': (105, 105, 105),
            'magic': (148, 0, 211),
            'ice': (0, 191, 255),
            'enemy_basic': (220, 20, 20),
            'enemy_fast': (34, 139, 34),
            'enemy_tank': (128, 0, 128),
            'enemy_boss': (255, 215, 0),
            'text': (255, 255, 255),
            'gold': (255, 215, 0),
            'lives': (255, 0, 0),
            'score': (0, 255, 0),
        }
        
        # Game state
        self.game_state = None
        self.selected_tower_type = "arrow"
        self.mouse_pos = (0, 0)
        self.font_small = pygame.font.Font(None, 24)
        self.font_medium = pygame.font.Font(None, 36)
        self.font_large = pygame.font.Font(None, 48)
        
        # UI buttons
        self.buttons = {}
        
    def update_state(self, state: GameState):
        """Update from API state"""
        self.game_state = state
    
    def draw_grid(self):
        """Draw background grid"""
        for x in range(0, self.width, 40):
            pygame.draw.line(self.screen, self.colors['grid'], (x, 0), (x, self.height))
        for y in range(0, self.height, 40):
            pygame.draw.line(self.screen, self.colors['grid'], (0, y), (self.width, y))
    
    def draw_tower(self, tower: Tower):
        """Draw a single tower"""
        x, y = int(tower.position.x), int(tower.position.y)
        
        # Range circle
        pygame.draw.circle(self.screen, (255, 255, 0, 50), (x, y), 
                          int(tower.range), 1)
        
        # Tower body
        color = self.colors.get(f'{tower.tower_type}', (255, 255, 255))
        pygame.draw.circle(self.screen, color, (x, y), 15)
        pygame.draw.circle(self.screen, (255, 255, 255), (x, y), 15, 2)
        
        # Level indicator
        if tower.level > 1:
            text = self.font_small.render(f"L{tower.level}", True, self.colors['text'])
            text_rect = text.get_rect(center=(x, y - 20))
            self.screen.blit(text, text_rect)
    
    def draw_enemy(self, enemy: Enemy):
        """Draw a single enemy"""
        x, y = int(enemy.position.x), int(enemy.position.y)
        
        # Health bar background
        bar_width = 30
        bar_height = 4
        pygame.draw.rect(self.screen, (100, 100, 100), 
                        (x - bar_width//2, y - 25, bar_width, bar_height))
        
        # Health bar fill
        health_pct = enemy.health / enemy.max_health
        color = (0, 255, 0) if health_pct > 0.6 else (255, 165, 0) if health_pct > 0.3 else (255, 0, 0)
        pygame.draw.rect(self.screen, color, 
                        (x - bar_width//2, y - 25, int(bar_width * health_pct), bar_height))
        
        # Enemy body
        color = self.colors.get(f'enemy_{enemy.enemy_type}', (255, 0, 0))
        if enemy.frozen:
            color = (135, 206, 250)  # Light blue when frozen
        
        size = 12 if enemy.enemy_type != 'boss' else 18
        pygame.draw.circle(self.screen, color, (x, y), size)
        
        # Enemy type indicator for boss
        if enemy.enemy_type == 'boss':
            pygame.draw.rect(self.screen, (0, 0, 0), (x - 20, y + 15, 40, 15))
            text = self.font_small.render("BOSS", True, (255, 255, 255))
            text_rect = text.get_rect(center=(x, y + 22))
            self.screen.blit(text, text_rect)
    
    def draw_projectiles(self):
        """Draw all projectiles"""
        for proj in self.game_state.projectiles:
            x, y = int(proj.position.x), int(proj.position.y)
            
            # Projectile color based on type
            colors = {
                'arrow': (139, 69, 19),
                'cannonball': (69, 69, 69),
                'magic': (148, 0, 211),
                'ice': (0, 191, 255)
            }
            
            color = colors.get(proj.projectile_type, (255, 255, 0))
            pygame.draw.circle(self.screen, color, (x, y), 4)
    
    def draw_ui(self):
        """Draw game UI elements"""
        if not self.game_state:
            return
        
        # Top bar - Gold, Lives, Score
        gold_text = self.font_medium.render(f"Gold: {self.game_state.gold}", True, self.colors['gold'])
        lives_text = self.font_medium.render(f"Lives: {self.game_state.lives}", True, self.colors['lives'])
        score_text = self.font_medium.render(f"Score: {self.game_state.score}", True, self.colors['score'])
        
        wave_text = self.font_medium.render(f"Wave: {self.game_state.wave}/{len(self.game_state.waves)}", 
                                           True, self.colors['text'])
        
        self.screen.blit(gold_text, (20, 10))
        self.screen.blit(lives_text, (200, 10))
        self.screen.blit(score_text, (400, 10))
        self.screen.blit(wave_text, (600, 10))
        
        # Tower selection buttons
        tower_types = ["arrow", "cannon", "magic", "ice"]
        costs = {"arrow": 50, "cannon": 100, "magic": 150, "ice": 120}
        colors_map = {"arrow": (139, 69, 19), "cannon": (105, 105, 105), 
                     "magic": (148, 0, 211), "ice": (0, 191, 255)}
        
        for i, ttype in enumerate(tower_types):
            x = 20 + i * 150
            y = 60
            
            # Button background
            color = colors_map[ttype] if self.selected_tower_type == ttype else (80, 80, 80)
            pygame.draw.rect(self.screen, color, (x, y, 140, 50))
            pygame.draw.rect(self.screen, (255, 255, 255), (x, y, 140, 50), 2)
            
            # Button text
            label = f"{ttype.capitalize()} (${costs[ttype]})"
            text = self.font_small.render(label, True, self.colors['text'])
            text_rect = text.get_rect(center=(x + 70, y + 25))
            self.screen.blit(text, text_rect)
            
            self.buttons[f'tower_{ttype}'] = (x, y, 140, 50)
        
        # Action buttons
        action_y = 130
        
        # Start Wave button
        if not any(e.is_alive for e in self.game_state.enemies):
            btn_rect = pygame.Rect(20, action_y, 120, 40)
            pygame.draw.rect(self.screen, (50, 205, 50), btn_rect)
            text = self.font_small.render("Start Wave", True, (255, 255, 255))
            text_rect = text.get_rect(center=(btn_rect.centerx, btn_rect.centery))
            self.screen.blit(text, text_rect)
            self.buttons['start_wave'] = btn_rect
        
        # Pause button
        pause_btn = pygame.Rect(150, action_y, 80, 40)
        pygame.draw.rect(self.screen, (255, 165, 0), pause_btn)
        text = self.font_small.render("Pause", True, (255, 255, 255))
        text_rect = text.get_rect(center=(pause_btn.centerx, pause_btn.centery))
        self.screen.blit(text, text_rect)
        self.buttons['pause'] = pause_btn
        
        # Game status overlay
        if self.game_state.game_status == 'gameover':
            self.draw_overlay("GAME OVER", "Press R to restart")
        elif self.game_state.game_status == 'victory':
            self.draw_overlay("VICTORY!", f"Final Score: {self.game_state.score}")
    
    def draw_overlay(self, title: str, subtitle: str):
        """Draw game status overlay"""
        # Semi-transparent background
        overlay = pygame.Surface((self.width, self.height))
        overlay.set_alpha(128)
        overlay.fill((0, 0, 0))
        self.screen.blit(overlay, (0, 0))
        
        # Title
        text = self.font_large.render(title, True, (255, 255, 255))
        text_rect = text.get_rect(center=(self.width//2, self.height//3))
        self.screen.blit(text, text_rect)
        
        # Subtitle
        sub_text = self.font_medium.render(subtitle, True, (200, 200, 200))
        sub_rect = sub_text.get_rect(center=(self.width//2, self.height//3 + 50))
        self.screen.blit(sub_text, sub_rect)
    
    def handle_input(self):
        """Handle mouse and keyboard input"""
        for event in pygame.event.get():
            if event.type == pygame.QUIT:
                return False
            
            elif event.type == pygame.MOUSEMOTION:
                self.mouse_pos = event.pos
            
            elif event.type == pygame.MOUSEBUTTONDOWN:
                if event.button == 1:  # Left click
                    x, y = event.pos
                    
                    # Check tower selection buttons
                    for name, rect in self.buttons.items():
                        if isinstance(rect, tuple) and rect[0] <= x <= rect[0] + rect[2]:
                            if rect[1] <= y <= rect[1] + rect[3]:
                                if name.startswith('tower_'):
                                    ttype = name.replace('tower_', '')
                                    self.selected_tower_type = ttype
                
                elif event.button == 3:  # Right click - place tower
                    x, y = event.pos
                    # Could send API call here
                    pass
            
            elif event.type == pygame.KEYDOWN:
                if event.key == pygame.K_r:
                    if self.game_state and self.game_state.game_status in ['gameover', 'victory']:
                        # Reset game
                        pass
                elif event.key == pygame.K_p:
                    if self.game_state:
                        self.game_state.game_status = 'paused' if self.game_state.game_status == 'playing' else 'playing'
        
        return True
    
    def render(self):
        """Main render loop"""
        running = True
        
        while running:
            # Clear screen
            self.screen.fill(self.colors['background'])
            
            # Draw grid
            self.draw_grid()
            
            if self.game_state:
                # Draw towers
                for tower in self.game_state.towers:
                    self.draw_tower(tower)
                
                # Draw enemies
                for enemy in self.game_state.enemies:
                    if enemy.is_alive:
                        self.draw_enemy(enemy)
                
                # Draw projectiles
                self.draw_projectiles()
            
            # Draw UI
            self.draw_ui()
            
            # Handle input
            running = self.handle_input()
            
            # Update display
            pygame.display.flip()
            self.clock.tick(60)  # 60 FPS
        
        pygame.quit()


def main():
    """Main entry point"""
    game = TowerDefenseGame()
    
    # Simulate some game state for demo
    from game_engine import GameEngine
    engine = GameEngine()
    engine.start_game()
    
    # Place a few towers
    engine.place_tower("arrow", 200, 300)
    engine.place_tower("cannon", 400, 250)
    engine.place_tower("magic", 600, 350)
    
    # Start first wave
    engine.start_wave()
    
    game.update_state(engine.state)
    game.render()


if __name__ == '__main__':
    main()
