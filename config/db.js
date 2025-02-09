const mysql = require('mysql2/promise');

const pool = mysql.createPool({
    host: process.env.MYSQL_HOST,
    user: process.env.MYSQL_USER,
    password: process.env.MYSQL_PASSWORD,
    database: process.env.MYSQL_DATABASE,
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

        await connection.execute(`
            CREATE TABLE IF NOT EXISTS users (
                id BIGINT PRIMARY KEY AUTO_INCREMENT,
                email VARCHAR(255) UNIQUE NOT NULL,
                password VARCHAR(255) NOT NULL,
                name VARCHAR(255),
                created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
                updated_at DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
            ) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci
        `);

        await connection.execute(`
            DELETE FROM job_descriptions 
            WHERE JSON_LENGTH(keywords) = 0
        `);

        // Validate existing records
        const [validationResults] = await connection.execute(`
            SELECT id, JSON_VALID(keywords) as valid 
            FROM job_descriptions
        `);
        
        validationResults.forEach(result => {
            if (!result.valid) {
                console.error(`Invalid JSON in record ${result.id}`);
            }
        });

        connection.release();
        console.log('Database initialized successfully');
    } catch (error) {
        console.error('Database initialization failed:', error);
        throw error;
    }
}

pool.on('connection', (connection) => {
    connection.on('error', (err) => {
        console.error('MySQL connection error:', err);
    });
});

pool.on('acquire', (connection) => {
    console.log('Connection %d acquired', connection.threadId);
});

pool.on('release', (connection) => {
    console.log('Connection %d released', connection.threadId);
});

module.exports = { pool, initializeDatabase }; 
