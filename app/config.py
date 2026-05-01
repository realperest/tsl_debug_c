from pydantic_settings import BaseSettings

class Settings(BaseSettings):
    app_version: str = "260429.0004"
    redis_url: str = "redis://localhost:6379/0"
    log_level: str = "INFO"

    class Config:
        env_file = ".env"

settings = Settings()
