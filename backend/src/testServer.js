const express = require('express');
const app = express();
app.use(express.json());

// Import real handlers from index.js by extracting routes
const main = require('./index');

module.exports = app;
