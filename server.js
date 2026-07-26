require('dotenv').config();
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const cors = require('cors');
const mongoose = require('mongoose');

const User = require('./models/User');
const Game = require('./models/Game');
const Transaction = require('./models/Transaction');

const app = express();
const server = http.createServer(app);

app.use(cors());
app.use(express.json({ limit: '5mb' }));
app.use(express.static(__dirname));

const io = new Server(server, { cors: { origin: '*' } });

// Connect to MongoDB
mongoose.connect(process.env.MONGODB_URI)
  .then(() => console.log('✅ Connected to MongoDB Atlas Database'))
  .catch(err => console.error('❌ MongoDB Connection Error:', err));

// Memory State
let currentBets = [];
let forcedResult = null;
let gameHistoryCache = [];

// Pre-load game history on startup
Game.find().sort({ createdAt: -1 }).limit(20).then(games => {
    gameHistoryCache = games.map(g => ({ period: g.period, result: g.result }));
});

let GAME_LOOP_SECONDS = 30;
let REFERRAL_BONUS = 500;
let timeLeft = GAME_LOOP_SECONDS;
let isBettingFrozen = false;
let currentPeriod = Date.now();

const OUTCOMES = {
  0: { color: 'RedViolet', label: 'Red & Violet' },
  1: { color: 'Green', label: 'Green' },
  2: { color: 'Red', label: 'Red' },
  3: { color: 'Green', label: 'Green' },
  4: { color: 'Red', label: 'Red' },
  5: { color: 'GreenViolet', label: 'Green & Violet' },
  6: { color: 'Red', label: 'Red' },
  7: { color: 'Green', label: 'Green' },
  8: { color: 'Red', label: 'Red' },
  9: { color: 'Green', label: 'Green' }
};

// Authentication Routes
app.post('/api/register', async (req, res) => {
    const { mobile, password, pin, referralCode } = req.body;
    if (!mobile || !password || !pin) return res.json({ success: false, message: 'All fields are required.' });
    
    try {
        let existing = await User.findOne({ mobile });
        if (existing) return res.json({ success: false, message: 'User already exists.' });
        
        let newReferralCode = Math.random().toString(36).substring(2, 8).toUpperCase();
        let referredBy = null;
        
        if (referralCode) {
            let referrer = await User.findOne({ referralCode });
            if (referrer) {
                referredBy = referrer._id.toString();
                referrer.balance += REFERRAL_BONUS;
                referrer.referralCount += 1;
                referrer.referralEarnings += REFERRAL_BONUS;
                await referrer.save();
            }
        }
        
        let newUser = new User({ mobile, password, pin, balance: 50000, history: [], referralCode: newReferralCode, referredBy });
        await newUser.save();
        res.json({ success: true, token: newUser._id, message: 'Registration successful!' });
    } catch (err) {
        res.json({ success: false, message: 'Database error.' });
    }
});

app.post('/api/login', async (req, res) => {
    const { mobile, password } = req.body;
    try {
        const user = await User.findOne({ mobile });
        if (!user || user.password !== password) return res.json({ success: false, message: 'Invalid mobile or password.' });
        
        res.json({ success: true, token: user._id, message: 'Login successful!' });
    } catch (err) {
        res.json({ success: false, message: 'Database error.' });
    }
});

app.get('/api/user', async (req, res) => {
    const userId = req.headers.authorization;
    if (!userId) return res.json({ success: false });
    try {
        const user = await User.findById(userId);
        if (user) {
            if (!user.referralCode) {
                user.referralCode = Math.random().toString(36).substring(2, 8).toUpperCase();
                await user.save();
            }
            res.json({ success: true, mobile: user.mobile, balance: user.balance, profilePic: user.profilePic || '', referralCode: user.referralCode, referralCount: user.referralCount, referralEarnings: user.referralEarnings });
        } else {
            res.json({ success: false });
        }
    } catch (e) {
        res.json({ success: false });
    }
});

app.post('/api/upload-avatar', async (req, res) => {
    const userId = req.headers.authorization;
    const { image } = req.body;
    if (!userId || !image) return res.json({ success: false });
    try {
        const user = await User.findById(userId);
        if (user) {
            user.profilePic = image;
            await user.save();
            res.json({ success: true });
        } else {
            res.json({ success: false });
        }
    } catch (e) {
        res.json({ success: false });
    }
});

app.post('/api/deposit', async (req, res) => {
    const userId = req.headers.authorization;
    const { amount, referenceNumber } = req.body;
    if (!userId || !amount || !referenceNumber || amount < 10) return res.json({ success: false, message: 'Invalid details or amount too low (Min $10).' });
    
    try {
        const user = await User.findById(userId);
        if (!user) return res.json({ success: false, message: 'User not found.' });

        const newTx = new Transaction({
            userId,
            type: 'deposit',
            amount: parseFloat(amount),
            status: 'pending',
            referenceNumber
        });
        await newTx.save();
        res.json({ success: true, message: 'Deposit request submitted successfully! Pending approval.' });
    } catch (err) {
        res.json({ success: false, message: 'Database error.' });
    }
});

app.post('/api/withdraw', async (req, res) => {
    const userId = req.headers.authorization;
    const { amount, withdrawalAddress, pin } = req.body;
    if (!userId || !amount || !withdrawalAddress || !pin || amount < 10) return res.json({ success: false, message: 'Invalid details or amount too low (Min $10).' });
    
    try {
        const user = await User.findById(userId);
        if (!user) return res.json({ success: false, message: 'User not found.' });
        if (user.pin !== pin) return res.json({ success: false, message: 'Incorrect Withdrawal PIN.' });
        if (user.balance < parseFloat(amount)) return res.json({ success: false, message: 'Insufficient balance.' });

        user.balance -= parseFloat(amount);
        await user.save();

        const newTx = new Transaction({
            userId,
            type: 'withdraw',
            amount: parseFloat(amount),
            status: 'pending',
            withdrawalAddress
        });
        await newTx.save();
        
        res.json({ success: true, message: 'Withdrawal request submitted successfully! Pending approval.', newBalance: user.balance });
    } catch (err) {
        res.json({ success: false, message: 'Database error.' });
    }
});

function calculateWinningResult() {
  if (forcedResult !== null) {
    const res = forcedResult;
    forcedResult = null;
    return res;
  }

  const liabilities = {};
  for (let i = 0; i <= 9; i++) liabilities[i] = 0;

  currentBets.forEach(bet => {
    for (let outcome = 0; outcome <= 9; outcome++) {
      let payout = 0;
      if (bet.type === 'number' && bet.value === outcome.toString()) payout = bet.amount * 9;
      if (bet.type === 'color') {
        const outStr = outcome.toString();
        if (bet.value === 'Green') {
          if (['1','3','7','9'].includes(outStr)) payout = bet.amount * 2;
          else if (outStr === '5') payout = bet.amount * 1.5;
        } else if (bet.value === 'Red') {
          if (['2','4','6','8'].includes(outStr)) payout = bet.amount * 2;
          else if (outStr === '0') payout = bet.amount * 1.5;
        } else if (bet.value === 'Violet') {
          if (['0','5'].includes(outStr)) payout = bet.amount * 4.5;
        }
      }
      liabilities[outcome] += payout;
    }
  });

  let minLiability = Infinity;
  let bestOutcomes = [];

  for (let i = 0; i <= 9; i++) {
    if (liabilities[i] < minLiability) {
      minLiability = liabilities[i];
      bestOutcomes = [i];
    } else if (liabilities[i] === minLiability) {
      bestOutcomes.push(i);
    }
  }

  const winningNumber = bestOutcomes[Math.floor(Math.random() * bestOutcomes.length)];
  return { number: winningNumber, colorLabel: OUTCOMES[winningNumber].label, colorKey: OUTCOMES[winningNumber].color };
}

async function processPayouts(winningResult) {
  const outStr = winningResult.number.toString();
  const userBetUpdates = {};
  
  currentBets.forEach(bet => {
    let payout = 0;
    
    if (bet.type === 'number' && bet.value === outStr) {
      payout = bet.amount * 9;
    } else if (bet.type === 'color') {
      if (bet.value === 'Green') {
        if (['1','3','7','9'].includes(outStr)) payout = bet.amount * 2;
        else if (outStr === '5') payout = bet.amount * 1.5;
      } else if (bet.value === 'Red') {
        if (['2','4','6','8'].includes(outStr)) payout = bet.amount * 2;
        else if (outStr === '0') payout = bet.amount * 1.5;
      } else if (bet.value === 'Violet') {
        if (['0','5'].includes(outStr)) payout = bet.amount * 4.5;
      }
    }

    if (!userBetUpdates[bet.userId]) {
        userBetUpdates[bet.userId] = { payoutTotal: 0, updates: [], socketId: bet.socketId };
    }
    
    userBetUpdates[bet.userId].payoutTotal += payout;
    userBetUpdates[bet.userId].updates.push({
        betId: bet.betId,
        payout: payout,
        status: payout > 0 ? 'won' : 'lost',
        result: winningResult
    });
  });

  for (const userId in userBetUpdates) {
      try {
          const u = await User.findById(userId);
          if (u) {
              const info = userBetUpdates[userId];
              u.balance += info.payoutTotal;
              
              info.updates.forEach(upd => {
                  const histItem = u.history.find(h => h.id === upd.betId);
                  if (histItem) {
                      histItem.status = upd.status;
                      histItem.result = upd.result;
                  }
              });
              
              await u.save();
              
              if (info.socketId) {
                  if (info.payoutTotal > 0) {
                      io.to(info.socketId).emit('bet_won', { payout: info.payoutTotal, newBalance: u.balance });
                  }
                  io.to(info.socketId).emit('my_history_update', u.history);
                  io.to(info.socketId).emit('update_balance', u.balance);
              }
          }
      } catch (err) {
          console.error("Error updating user payouts", err);
      }
  }
}

function broadcastAdminUpdate() {
  const totals = { Red: 0, Green: 0, Violet: 0, numbers: {} };
  for(let i=0; i<=9; i++) totals.numbers[i] = 0;

  currentBets.forEach(bet => {
    if (bet.type === 'color') totals[bet.value] += bet.amount;
    if (bet.type === 'number') totals.numbers[bet.value] += bet.amount;
  });
  io.emit('admin_dashboard_update', totals);
}

setInterval(async () => {
  timeLeft--;
  io.emit('time_left', { period: currentPeriod, timeLeft });

  if (timeLeft === 0) {
    isBettingFrozen = true;
    io.emit('betting_frozen', true);

    const result = calculateWinningResult();
    await processPayouts(result);

    const newGame = new Game({ period: currentPeriod, result });
    await newGame.save();
    
    gameHistoryCache.unshift({ period: currentPeriod, result });
    if (gameHistoryCache.length > 20) gameHistoryCache.pop();

    io.emit('period_result', { period: currentPeriod, result });

    setTimeout(() => {
      currentBets = [];
      currentPeriod = Date.now();
      timeLeft = GAME_LOOP_SECONDS;
      isBettingFrozen = false;
      broadcastAdminUpdate();
      io.emit('new_period', { period: currentPeriod, timeLeft });
    }, 2000);
  }
}, 1000);

io.on('connection', async (socket) => {
  const userId = socket.handshake.query.userId;

  socket.emit('time_left', { period: currentPeriod, timeLeft });
  socket.emit('betting_frozen', isBettingFrozen);
  socket.emit('history_update', gameHistoryCache);
  
  if (userId && userId !== 'guest') {
      try {
          const user = await User.findById(userId);
          if (user) {
              socket.emit('user_info', { mobile: user.mobile, balance: user.balance });
              socket.emit('my_history_update', user.history);
              socket.emit('update_balance', user.balance);
          }
      } catch (e) {
          // invalid ID
      }
  }

  socket.on('request_admin_data', () => {
    broadcastAdminUpdate();
  });

  socket.on('submit_bet', async (data, callback) => {
    if (isBettingFrozen) return callback({ success: false, message: 'Betting frozen.' });
    
    const { userId, type, value, amount } = data;
    try {
        const user = await User.findById(userId);
        if (!user) return callback({ success: false, message: 'Invalid user.' });
        if (user.balance < amount) return callback({ success: false, message: 'Insufficient balance.' });

        user.balance -= amount;
        
        const betId = Date.now().toString();
        const betRecord = { id: betId, period: currentPeriod, type, value, amount, status: 'pending', result: null };
        user.history.unshift(betRecord);
        await user.save();
        
        currentBets.push({ userId, socketId: socket.id, betId, type, value, amount, period: currentPeriod });
        
        socket.emit('my_history_update', user.history);
        broadcastAdminUpdate(); 
        
        callback({ success: true, newBalance: user.balance });
    } catch(err) {
        return callback({ success: false, message: 'Database error.' });
    }
  });

  socket.on('admin_force_result', (data, callback) => {
    forcedResult = { number: parseInt(data.number), colorLabel: OUTCOMES[data.number].label, colorKey: OUTCOMES[data.number].color };
    callback({ success: true });
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`🚀 888.lk Backend Server Running on Port ${PORT}`);
});
