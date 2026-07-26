const mongoose = require('mongoose');

const gameSchema = new mongoose.Schema({
    period: { type: Number, required: true, unique: true },
    result: { type: Object, required: true },
    createdAt: { type: Date, default: Date.now }
});

module.exports = mongoose.model('Game', gameSchema);
