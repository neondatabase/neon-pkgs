CREATE TABLE IF NOT EXISTS users (
    id SERIAL PRIMARY KEY,
    username VARCHAR(50) NOT NULL UNIQUE,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

INSERT INTO users (username) VALUES
    ('John Lennon'),
    ('Paul McCartney'), 
    ('George Harrison'),
    ('Ringo Starr'),
    ('Stuart Sutcliffe'),
    ('Pete Best'),
    ('George Martin');
