require('dotenv').config();
const express = require('express');
const http = require('http');
const fs = require('fs');
const path = require('path');
const { Server } = require('socket.io');
const cors = require('cors');
const mongoose = require('mongoose');

const User = require('./models/User');
const Game = require('./models/Game');
const Transaction = require('./models/Transaction');
const Setting = require('./models/Setting');

const app = express();
const server = http.createServer(app);

app.use(cors());
app.use(express.json({ limit: '50mb' }));
app.use(express.static(__dirname));

const io = new Server(server, { cors: { origin: '*' } });

// Connect to MongoDB
mongoose.connect(process.env.MONGODB_URI)
  .then(async () => {
      console.log('✅ Connected to MongoDB Atlas Database');
      // Load Initial Settings
      try {
          let algoSetting = await Setting.findOne({ key: 'game_algorithm' });
          if (algoSetting) GAME_ALGORITHM = algoSetting.value;
      } catch(e) {}
  })
  .catch(err => console.error('❌ MongoDB Connection Error:', err));

// Memory State
let currentBets = [];
let forcedResult = null;
let scheduledTimes = []; // Array of { id, timestamp, result: {number, colorLabel, colorKey} }
let gameHistoryCache = [];
let GAME_ALGORITHM = 'min_liability'; // Default algorithm
let GAME_LOOP_SECONDS = 30;
let REFERRAL_BONUS = 500;
let timeLeft = GAME_LOOP_SECONDS;
let isBettingFrozen = false;

function getNextPeriodId() {
    const d = new Date();
    // Use Sri Lanka Time (GMT+5:30)
    const slTime = new Date(d.toLocaleString('en-US', { timeZone: 'Asia/Colombo' }));
    
    const pad = (n) => n.toString().padStart(2, '0');
    const todayStr = `${slTime.getFullYear()}${pad(slTime.getMonth()+1)}${pad(slTime.getDate())}`;

    const hours = slTime.getHours();
    const minutes = slTime.getMinutes();
    const seconds = slTime.getSeconds();

    const totalSeconds = (hours * 3600) + (minutes * 60) + seconds;
    const seq = Math.floor(totalSeconds / GAME_LOOP_SECONDS) + 1;

    return todayStr + seq.toString().padStart(4, '0');
}

function getPeriodIdForTimestamp(ts) {
    const d = new Date(ts);
    const slTime = new Date(d.toLocaleString('en-US', { timeZone: 'Asia/Colombo' }));
    
    const pad = (n) => n.toString().padStart(2, '0');
    const todayStr = `${slTime.getFullYear()}${pad(slTime.getMonth()+1)}${pad(slTime.getDate())}`;

    const hours = slTime.getHours();
    const minutes = slTime.getMinutes();
    const seconds = slTime.getSeconds();

    const totalSeconds = (hours * 3600) + (minutes * 60) + seconds;
    const seq = Math.floor(totalSeconds / GAME_LOOP_SECONDS) + 1;

    return todayStr + seq.toString().padStart(4, '0');
}

let currentPeriod = getNextPeriodId();

// Pre-load game history on startup
Game.find().sort({ createdAt: -1 }).limit(20).then(games => {
    gameHistoryCache = games.map(g => ({ period: String(g.period), result: g.result }));
    if (games.length > 0) {
        currentPeriod = getNextPeriodId();
    }
});

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
    const { mobile, password, pin, referralCode, name, country, age, sex } = req.body;
    if (!mobile || !password || !pin || !name || !country || !age || !sex) return res.json({ success: false, message: 'All fields are required.' });
    
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
        
        let newUser = new User({ mobile, password, pin, name, country, age, sex, balance: 50000, history: [], referralCode: newReferralCode, referredBy });
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
            res.json({ success: true, mobile: user.mobile, balance: user.balance, profilePic: user.profilePic || '', referralCode: user.referralCode, referralCount: user.referralCount, referralEarnings: user.referralEarnings, name: user.name, country: user.country, age: user.age, sex: user.sex });
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

app.post('/api/user/change-password', async (req, res) => {
    const userId = req.headers.authorization;
    const { oldPassword, newPassword } = req.body;
    if (!userId || !oldPassword || !newPassword) return res.json({ success: false, message: 'Missing details.' });
    
    try {
        const user = await User.findById(userId);
        if (!user) return res.json({ success: false, message: 'User not found.' });
        if (user.password !== oldPassword) return res.json({ success: false, message: 'Old password is incorrect.' });
        
        user.password = newPassword;
        await user.save();
        res.json({ success: true, message: 'Password updated successfully!' });
    } catch (e) {
        res.json({ success: false, message: 'Database error.' });
    }
});

app.post('/api/deposit', async (req, res) => {
    const userId = req.headers.authorization;
    const { amount, referenceNumber, receiptImage } = req.body;
    if (!userId || !amount || !referenceNumber || amount < 10) return res.json({ success: false, message: 'Invalid details or amount too low (Min $10).' });
    
    try {
        const user = await User.findById(userId);
        if (!user) return res.json({ success: false, message: 'User not found.' });

        const newTx = new Transaction({
            userId,
            type: 'deposit',
            amount: parseFloat(amount),
            status: 'pending',
            referenceNumber,
            receiptImage: receiptImage || ''
        });
        await newTx.save();
        io.emit('admin_alert', { type: 'deposit', amount: parseFloat(amount), mobile: user.mobile });
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
        io.emit('admin_alert', { type: 'withdraw', amount: parseFloat(amount), mobile: user.mobile });
        res.json({ success: true, message: 'Withdrawal request submitted successfully! Pending approval.', newBalance: user.balance });
    } catch (err) {
        res.json({ success: false, message: 'Database error.' });
    }
});

app.get('/api/transactions', async (req, res) => {
    const userId = req.headers.authorization;
    if (!userId) return res.json({ success: false });
    try {
        const txs = await Transaction.find({ userId }).sort({ createdAt: -1 });
        res.json({ success: true, transactions: txs });
    } catch (e) {
        res.json({ success: false });
    }
});

// --- ADMIN API ENDPOINTS ---
const ADMIN_TOKEN = 'admin_secret_token_123';

app.post('/api/admin/login', (req, res) => {
    const { username, password } = req.body;
    if (username === 'admin' && password === '888admin') { 
        res.json({ success: true, token: ADMIN_TOKEN });
    } else {
        res.json({ success: false, message: 'Invalid credentials.' });
    }
});

// Admin Middleware
function adminAuth(req, res, next) {
    if (req.headers.authorization !== ADMIN_TOKEN) return res.json({ success: false, message: 'Unauthorized' });
    next();
}

app.get('/api/admin/stats', adminAuth, async (req, res) => {
    try {
        const totalUsers = await User.countDocuments();
        const users = await User.find();
        const totalBalances = users.reduce((acc, u) => acc + u.balance, 0);
        const pendingTxns = await Transaction.countDocuments({ status: 'pending' });
        
        // Calculate Today's Profit
        const today = new Date();
        today.setHours(0,0,0,0);
        const todaysTxns = await Transaction.find({ status: 'approved', updatedAt: { $gte: today } });
        let todayProfit = 0;
        todaysTxns.forEach(tx => {
            if(tx.type === 'deposit') todayProfit += tx.amount;
            if(tx.type === 'withdraw') todayProfit -= tx.amount;
        });

        res.json({ success: true, totalUsers, totalBalances, pendingTxns, todayProfit, referralBonus: REFERRAL_BONUS });
    } catch (e) {
        res.json({ success: false });
    }
});

// Admin Chart Stats
app.get('/api/admin/stats/chart', adminAuth, async (req, res) => {
    try {
        const today = new Date();
        const sevenDaysAgo = new Date(today);
        sevenDaysAgo.setDate(today.getDate() - 6);
        sevenDaysAgo.setHours(0, 0, 0, 0);

        const txns = await Transaction.find({
            status: 'approved',
            updatedAt: { $gte: sevenDaysAgo }
        });

        const dailyData = {};
        for(let i=6; i>=0; i--) {
            let d = new Date(today);
            d.setDate(d.getDate() - i);
            const dateStr = d.toISOString().split('T')[0];
            dailyData[dateStr] = { deposits: 0, withdrawals: 0 };
        }

        txns.forEach(tx => {
            const dateStr = tx.updatedAt.toISOString().split('T')[0];
            if(dailyData[dateStr]) {
                if(tx.type === 'deposit') dailyData[dateStr].deposits += tx.amount;
                if(tx.type === 'withdraw') dailyData[dateStr].withdrawals += tx.amount;
            }
        });

        const labels = Object.keys(dailyData);
        const deposits = labels.map(l => dailyData[l].deposits);
        const withdrawals = labels.map(l => dailyData[l].withdrawals);
        const profit = labels.map(l => dailyData[l].deposits - dailyData[l].withdrawals);

        res.json({ success: true, labels, deposits, withdrawals, profit });
    } catch (e) {
        res.json({ success: false });
    }
});

// Settings Endpoints
app.get('/api/settings', async (req, res) => {
    try {
        let bannerSetting = await Setting.findOne({ key: 'home_banner' });
        const bannerUrl = bannerSetting ? bannerSetting.value : ''; // Return empty if none
        res.json({ success: true, banner: bannerUrl });
    } catch (e) {
        res.json({ success: false });
    }
});

app.post('/api/admin/settings/banner', adminAuth, async (req, res) => {
    try {
        let { banner } = req.body;
        if (banner === undefined) banner = ''; // allow empty
        
        await Setting.findOneAndUpdate(
            { key: 'home_banner' },
            { value: banner },
            { upsert: true }
        );
        res.json({ success: true });
    } catch (e) {
        res.json({ success: false });
    }
});

app.get('/api/admin/settings/algorithm', adminAuth, async (req, res) => {
    try {
        let algoSetting = await Setting.findOne({ key: 'game_algorithm' });
        const algo = algoSetting ? algoSetting.value : 'min_liability';
        GAME_ALGORITHM = algo; // sync memory
        res.json({ success: true, algorithm: algo });
    } catch (e) {
        res.json({ success: false });
    }
});

app.post('/api/admin/settings/algorithm', adminAuth, async (req, res) => {
    try {
        let { algorithm } = req.body;
        if (!['min_liability', 'true_random'].includes(algorithm)) algorithm = 'min_liability';
        
        await Setting.findOneAndUpdate(
            { key: 'game_algorithm' },
            { value: algorithm },
            { upsert: true }
        );
        GAME_ALGORITHM = algorithm; // sync memory
        res.json({ success: true, algorithm });
    } catch (e) {
        res.json({ success: false });
    }
});

app.post('/api/admin/settings', adminAuth, (req, res) => {
    if (req.body.referralBonus) REFERRAL_BONUS = parseFloat(req.body.referralBonus);
    res.json({ success: true });
});

app.get('/api/admin/transactions', adminAuth, async (req, res) => {
    try {
        const { type } = req.query; // 'deposit' or 'withdraw'
        const transactions = await Transaction.find({ status: 'pending', type }).populate('userId', 'mobile name').sort({ createdAt: 1 });
        res.json({ success: true, transactions });
    } catch (e) {
        res.json({ success: false });
    }
});

app.post('/api/admin/transactions/:id/:action', adminAuth, async (req, res) => {
    try {
        const { id, action } = req.params; // action = 'approve' or 'reject'
        const tx = await Transaction.findById(id);
        if (!tx || tx.status !== 'pending') return res.json({ success: false, message: 'Invalid transaction.' });
        
        const user = await User.findById(tx.userId);
        if (!user) return res.json({ success: false, message: 'User not found.' });
        
        if (tx.type === 'deposit') {
            if (action === 'approve') {
                user.balance += tx.amount;
            }
        } else if (tx.type === 'withdraw') {
            if (action === 'reject') {
                user.balance += tx.amount; // refund balance on reject
            }
        }
        
        tx.status = action === 'approve' ? 'approved' : 'rejected';
        await tx.save();
        await user.save();
        
        res.json({ success: true });
    } catch (e) {
        res.json({ success: false });
    }
});

app.get('/api/admin/users', adminAuth, async (req, res) => {
    try {
        const users = await User.find().sort({ createdAt: -1 });
        res.json({ success: true, users });
    } catch (e) {
        res.json({ success: false });
    }
});

app.post('/api/admin/game', adminAuth, (req, res) => {
    const { number } = req.body;
    forcedResult = { number: parseInt(number), colorLabel: OUTCOMES[number].label, colorKey: OUTCOMES[number].color };
    res.json({ success: true });
});

app.get('/api/admin/live-bets', adminAuth, async (req, res) => {
    try {
        const betsWithUser = await Promise.all(currentBets.map(async (bet) => {
            const user = await User.findById(bet.userId);
            return { ...bet, mobile: user ? user.mobile : 'Unknown' };
        }));
        res.json({ success: true, bets: betsWithUser, timeLeft, forcedResult, scheduledTimes, currentPeriod, GAME_LOOP_SECONDS });
    } catch (e) {
        res.json({ success: false });
    }
});

app.get('/api/admin/transactions/history', adminAuth, async (req, res) => {
    try {
        const transactions = await Transaction.find({ status: { $ne: 'pending' } }).populate('userId', 'mobile name').sort({ updatedAt: -1 }).limit(100);
        res.json({ success: true, transactions });
    } catch (e) {
        res.json({ success: false });
    }
});

app.post('/api/admin/tx-revert/:id', adminAuth, async (req, res) => {
    try {
        const tx = await Transaction.findById(req.params.id);
        if (!tx || tx.status === 'pending') return res.json({ success: false, message: 'Invalid transaction.' });
        
        const user = await User.findById(tx.userId);
        if (!user) return res.json({ success: false, message: 'User not found.' });
        
        if (tx.type === 'deposit' && tx.status === 'approved') {
            user.balance -= tx.amount;
        } else if (tx.type === 'withdraw' && tx.status === 'rejected') {
            user.balance -= tx.amount;
        }
        
        tx.status = 'pending';
        await tx.save();
        await user.save();
        
        res.json({ success: true });
    } catch (e) {
        res.json({ success: false });
    }
});

app.get('/api/admin/game-history', adminAuth, (req, res) => {
    res.json({ success: true, history: gameHistoryCache });
});

app.get('/api/admin/users/:id', adminAuth, async (req, res) => {
    try {
        const user = await User.findById(req.params.id);
        if (!user) return res.json({ success: false });
        res.json({ success: true, user });
    } catch (e) {
        res.json({ success: false });
    }
});

app.post('/api/admin/users/:id/balance', adminAuth, async (req, res) => {
    try {
        const { amount, action } = req.body;
        const user = await User.findById(req.params.id);
        if (!user) return res.json({ success: false });
        
        const val = parseFloat(amount);
        if (action === 'add') user.balance += val;
        else if (action === 'subtract') user.balance -= val;
        
        await user.save();
        res.json({ success: true, newBalance: user.balance });
    } catch (e) {
        res.json({ success: false });
    }
});

app.post('/api/admin/users/:id/password', adminAuth, async (req, res) => {
    try {
        const { newPassword } = req.body;
        const user = await User.findById(req.params.id);
        if (!user) return res.json({ success: false });
        
        user.password = newPassword;
        await user.save();
        res.json({ success: true });
    } catch (e) {
        res.json({ success: false });
    }
});

// ---------------------------

function calculateWinningResult() {
  if (forcedResult !== null) {
    const res = forcedResult;
    forcedResult = null;
    return res;
  }

  // Check scheduled times
  const nowMs = Date.now();
  // Sort just in case, though they should be inserted in order usually
  scheduledTimes.sort((a, b) => a.timestamp - b.timestamp);
  
  const idx = scheduledTimes.findIndex(s => s.timestamp <= nowMs);
  if (idx !== -1) {
      const res = scheduledTimes[idx].result;
      scheduledTimes.splice(idx, 1); // Remove the executed schedule
      broadcastAdminUpdate(); // Update admins that a schedule was consumed
      return res;
  }

  // --- ALGORITHM LOGIC ---
  if (GAME_ALGORITHM === 'true_random') {
      const winningNumber = Math.floor(Math.random() * 10);
      return { number: winningNumber, colorLabel: OUTCOMES[winningNumber].label, colorKey: OUTCOMES[winningNumber].color };
  }

  // default: min_liability
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
              
              u.markModified('history');
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
  io.emit('admin_dashboard_update', { totals, scheduledTimes });
}

let isResolving = false;
setInterval(async () => {
  const d = new Date();
  const slTime = new Date(d.toLocaleString('en-US', { timeZone: 'Asia/Colombo' }));
  const totalSeconds = (slTime.getHours() * 3600) + (slTime.getMinutes() * 60) + slTime.getSeconds();
  
  let newTimeLeft = GAME_LOOP_SECONDS - (totalSeconds % GAME_LOOP_SECONDS);
  
  if (newTimeLeft <= 2) {
    if (!isResolving) {
      isResolving = true;
      isBettingFrozen = true;
      io.emit('betting_frozen', true);

      const result = calculateWinningResult();
      await processPayouts(result);

      const newGame = new Game({ period: currentPeriod, result });
      await newGame.save();
      
      gameHistoryCache.unshift({ period: currentPeriod, result });
      if (gameHistoryCache.length > 20) gameHistoryCache.pop();

      io.emit('period_result', { period: currentPeriod, result });
    }
    // Stay at 0 in UI during resolution
    if (timeLeft !== 0) {
      timeLeft = 0;
      io.emit('time_left', { period: currentPeriod, timeLeft });
    }
  } else {
    if (isResolving) {
      // New round begins!
      isResolving = false;
      isBettingFrozen = false;
      currentPeriod = getNextPeriodId();
      currentBets = [];
      broadcastAdminUpdate();
      io.emit('new_period', { period: currentPeriod, timeLeft: newTimeLeft });
    }
    if (timeLeft !== newTimeLeft) {
      timeLeft = newTimeLeft;
      io.emit('time_left', { period: currentPeriod, timeLeft });
    }
  }
}, 500);

// --- AVIATOR GAME LOGIC ---
let aviatorState = 'WAITING'; // WAITING, FLYING, CRASHED
let aviatorStartTime = null;
let aviatorCrashMultiplier = 1.00;
let aviatorForcedCrash = null;
let aviatorBets = []; // { userId, socketId, amount, betId, name }
let aviatorWaitTime = 10.0;
let aviatorCrashedTime = 0.0;

function getAviatorMultiplier(startTime) {
    if (!startTime) return 1.00;
    const elapsedMs = Date.now() - startTime;
    const seconds = elapsedMs / 1000;
    const M = Math.pow(Math.E, 0.06 * seconds);
    return Math.max(1.00, M);
}

function generateAviatorCrash() {
    if (aviatorForcedCrash) {
        let val = parseFloat(aviatorForcedCrash);
        aviatorForcedCrash = null;
        return val;
    }
    const r = Math.random();
    if (r < 0.02) return 1.00; // 2% chance of instant crash
    const mult = 1.00 / (1.0 - Math.random() * 0.99); // 1.00x to 100.00x
    return parseFloat(mult.toFixed(2));
}

setInterval(() => {
    if (aviatorState === 'WAITING') {
        aviatorWaitTime -= 0.1;
        if (aviatorWaitTime <= 0) {
            aviatorState = 'FLYING';
            aviatorCrashMultiplier = generateAviatorCrash();
            aviatorStartTime = Date.now();
            io.emit('aviator_start', { startTime: aviatorStartTime });
        }
    } else if (aviatorState === 'FLYING') {
        const currentMult = getAviatorMultiplier(aviatorStartTime);
        if (currentMult >= aviatorCrashMultiplier) {
            aviatorState = 'CRASHED';
            aviatorCrashedTime = 5.0; // 5 seconds wait before next round
            io.emit('aviator_crashed', { multiplier: aviatorCrashMultiplier });
            
            // Process losses for users who didn't cash out
            aviatorBets.forEach(async (bet) => {
                 try {
                     const user = await User.findById(bet.userId);
                     if(user) {
                         const idx = user.history.findIndex(h => h.id === bet.betId);
                         if(idx > -1) {
                             user.history[idx].status = 'lost';
                             user.history[idx].result = { multiplier: aviatorCrashMultiplier };
                             await user.save();
                         }
                     }
                 } catch(e) {}
            });
            aviatorBets = []; // Clear bets for next round
        }
    } else if (aviatorState === 'CRASHED') {
        aviatorCrashedTime -= 0.1;
        if (aviatorCrashedTime <= 0) {
            aviatorState = 'WAITING';
            aviatorWaitTime = 10.0;
            io.emit('aviator_waiting', { waitTime: aviatorWaitTime });
        }
    }
}, 100);

io.on('connection', async (socket) => {
  const userId = socket.handshake.query.userId;

  socket.emit('time_left', { period: currentPeriod, timeLeft });
  socket.emit('betting_frozen', isBettingFrozen);
  socket.emit('history_update', gameHistoryCache);
  socket.emit('aviator_init', {
      state: aviatorState,
      startTime: aviatorStartTime,
      waitTime: aviatorWaitTime,
      players: aviatorBets
  });
  
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

  // --- AVIATOR SOCKET EVENTS ---
  socket.on('aviator_bet', async (data, callback) => {
    if (aviatorState !== 'WAITING') return callback({ success: false, message: 'Please wait for the next round.' });
    const { userId, amount } = data;
    if(amount < 10) return callback({ success: false, message: 'Minimum bet is $10.' });
    
    try {
        const user = await User.findById(userId);
        if(!user || user.balance < amount) return callback({success: false, message: 'Insufficient balance.'});
        if (aviatorBets.find(b => b.userId === userId)) return callback({ success: false, message: 'Already bet in this round.' });
        
        user.balance -= amount;
        const betId = Date.now().toString();
        user.history.unshift({ id: betId, period: 'AVIATOR', type: 'aviator', value: '0', amount, status: 'pending' });
        await user.save();
        
        aviatorBets.push({ userId, amount, betId, name: user.name, socketId: socket.id });
        
        socket.emit('update_balance', user.balance);
        io.emit('aviator_players', aviatorBets);
        callback({ success: true, balance: user.balance });
    } catch(e) {
        callback({ success: false, message: 'Server error' });
    }
  });

  socket.on('aviator_cashout', async (data, callback) => {
    if (aviatorState !== 'FLYING') return callback({ success: false, message: 'Game is not flying!' });
    const betIdx = aviatorBets.findIndex(b => b.userId === data.userId);
    if (betIdx === -1) return callback({ success: false, message: 'No active bet found.' });
    
    const bet = aviatorBets[betIdx];
    const currentMult = parseFloat(getAviatorMultiplier(aviatorStartTime).toFixed(2));
    
    if (currentMult >= aviatorCrashMultiplier) {
        return callback({ success: false, message: 'Plane crashed already!' });
    }
    
    aviatorBets.splice(betIdx, 1); // User successfully cashed out
    const winAmount = bet.amount * currentMult;
    
    try {
        const user = await User.findById(bet.userId);
        if(user) {
            user.balance += winAmount;
            const hIdx = user.history.findIndex(h => h.id === bet.betId);
            if(hIdx > -1) {
                user.history[hIdx].status = 'won';
                user.history[hIdx].result = { multiplier: currentMult };
            }
            await user.save();
            socket.emit('update_balance', user.balance);
            io.emit('aviator_players', aviatorBets); // update list for everyone
            callback({ success: true, multiplier: currentMult, winAmount, balance: user.balance });
        }
    } catch(e) {
        callback({ success: false, message: 'Server error' });
    }
  });

  socket.on('admin_force_aviator', (data, callback) => {
    aviatorForcedCrash = data.multiplier;
    callback({ success: true });
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

  socket.on('admin_schedule_result', (data, callback) => {
    const { timestamp, number } = data;
    const id = Date.now().toString();
    const targetPeriod = getPeriodIdForTimestamp(parseInt(timestamp));
    const result = { number: parseInt(number), colorLabel: OUTCOMES[number].label, colorKey: OUTCOMES[number].color };
    scheduledTimes.push({ id, timestamp: parseInt(timestamp), result, targetPeriod });
    broadcastAdminUpdate();
    callback({ success: true });
  });

  socket.on('admin_remove_scheduled', (data, callback) => {
    const { id } = data;
    scheduledTimes = scheduledTimes.filter(s => s.id !== id);
    broadcastAdminUpdate();
    callback({ success: true });
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`🚀 888.lk Backend Server Running on Port ${PORT}`);
});
