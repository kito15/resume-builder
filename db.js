const mysql = require('mysql2/promise');

const pool = mysql.createPool({
    host: process.env.MYSQL_HOST,
    user: process.env.MYSQL_USER,
    password: process.env.MYSQL_PASSWORD,
    database: process.env.MYSQL_DATABASE,
    port: process.env.MYSQLPORT,
    waitForConnections: true,
    connectionLimit: 10,
    queueLimit: 0
});

// Initialize database tables
async function initializeDatabase() {
    try {
        const connection = await pool.getConnection();
        
        await connection.execute(`
            CREATE TABLE IF NOT EXISTS job_descriptions (
                id BIGINT PRIMARY KEY AUTO_INCREMENT,
                content_hash VARCHAR(64) NOT NULL,
                full_text LONGTEXT NOT NULL,
                keywords JSON NOT NULL,
                char_length INT NOT NULL,
                normalized_text LONGTEXT NOT NULL,
                created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
                updated_at DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
                INDEX idx_content_hash (content_hash),
                INDEX idx_char_length (char_length),
                FULLTEXT idx_normalized_text (normalized_text)
            ) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci
        `);

        connection.release();
        console.log('Database initialized successfully');
    } catch (error) {
        console.error('Database initialization failed:', error);
        throw error;
    }
}

module.exports = { pool, initializeDatabase }; 
