const express = require('express');
const bcrypt = require('bcrypt');
const router = express.Router();
const { pool } = require('./config/db');

// Signup endpoint
router.post('/signup', async (req, res) => {
    try {
        const { name, email, password } = req.body;
        if (!name || !email || !password) {
            return res.status(400).json({ error: 'Name, email, and password are required' });
        }
        // Hash password with a salt round of 10
        const hashedPassword = await bcrypt.hash(password, 10);
        // Insert user into the database
        const [result] = await pool.execute(
            'INSERT INTO users (name, email, password) VALUES (?, ?, ?)',
            [name, email, hashedPassword]
        );
        res.json({ success: true, userId: result.insertId, redirectUrl: '/dashboard' });
    } catch (error) {
        console.error('Signup error:', error);
        res.status(500).json({ error: error.message });
    }
});

// Login endpoint
router.post('/login', async (req, res) => {
    try {
        const { email, password } = req.body;
        if(!email || !password) {
            return res.status(400).json({ error: 'Email and password are required' });
        }
        // Find user by email
        const [users] = await pool.execute(
            'SELECT * FROM users WHERE email = ?',
            [email]
        );
        if (users.length === 0) {
            return res.status(401).json({ error: 'Invalid email or password' });
        }
        const user = users[0];
        // Compare the given password with the hashed password in the DB
        const passwordMatch = await bcrypt.compare(password, user.password);
        if (!passwordMatch) {
            return res.status(401).json({ error: 'Invalid email or password' });
        }
        // Return a simple success response (no JWT used)
        res.json({ 
            success: true, 
            userId: user.id, 
            name: user.name, 
            email: user.email,
            redirectUrl: '/dashboard'
        });
    } catch (error) {
        console.error('Login error:', error);
        res.status(500).json({ error: error.message });
    }
});

module.exports = router;
