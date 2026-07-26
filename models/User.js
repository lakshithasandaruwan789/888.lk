const mongoose = require('mongoose');

const betHistorySchema = new mongoose.Schema({
    id: String,
    period: Number,
    type: { type: String }, // 'number' or 'color'
    value: String,
    amount: Number,
    status: { type: String, enum: ['pending', 'won', 'lost'], default: 'pending' },
    result: { type: Object, default: null },
    createdAt: { type: Date, default: Date.now }
});

const userSchema = new mongoose.Schema({
    mobile: { type: String, required: true, unique: true },
    password: { type: String, required: true },
    pin: { type: String, required: true },
    balance: { type: Number, default: 50000 },
    history: [betHistorySchema]
}, { timestamps: true });

module.exports = mongoose.model('User', userSchema);
