const mongoose = require('mongoose');

const transactionSchema = new mongoose.Schema({
    userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    type: { type: String, enum: ['deposit', 'withdraw'], required: true },
    amount: { type: Number, required: true },
    status: { type: String, enum: ['pending', 'approved', 'rejected'], default: 'pending' },
    paymentMethod: { type: String, default: 'USDT TRC20' },
    referenceNumber: { type: String, default: '' }, // For deposits (Tx Hash)
    withdrawalAddress: { type: String, default: '' }, // For withdrawals
    receiptImage: { type: String, default: '' } // Base64 or URL
}, { timestamps: true });

module.exports = mongoose.model('Transaction', transactionSchema);
