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
    history: [betHistorySchema],
    profilePic: { type: String, default: '' },
    name: { type: String, default: 'User' },
    country: { type: String, default: 'Sri Lanka' },
    age: { type: Number, default: 18 },
    sex: { type: String, default: 'Male' },
    referralCode: { type: String, unique: true },
    referredBy: { type: String, default: null },
    referralCount: { type: Number, default: 0 },
    referralEarnings: { type: Number, default: 0 }
}, { timestamps: true });

module.exports = mongoose.model('User', userSchema);
