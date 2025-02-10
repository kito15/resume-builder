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

// Add route to serve profile section partial
router.get('/partials/profile-section', (req, res) => {
    res.render('partials/profile-section');
});

// Add notes section route
router.get('/partials/notes-section', (req, res) => {
    res.render('partials/notes-section');
});

// Add resume section route
router.get('/partials/resume-section', (req, res) => {
    res.render('partials/resume-section');
});

module.exports = router;
