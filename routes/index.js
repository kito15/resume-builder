const express = require('express');
const path = require('path');
const router = express.Router();

// Serve the index.ejs template for the root route
router.get('/', (req, res) => {
  res.render('index');
});

// Add login route
router.get('/login', (req, res) => {
  res.render('login');
});

// Add dashboard route
router.get('/dashboard', (req, res) => {
  res.render('dashboard');
});

module.exports = router;
