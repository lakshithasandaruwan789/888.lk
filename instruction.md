# 888.lk Project Instructions

Welcome to the **888.lk** project! This document outlines the architecture, file structure, and instructions to run the application.

## Project Structure

The project is divided into two main phases:
1. **Frontend (UI)**: Built with HTML and Tailwind CSS (Dark Navy and Gold theme).
2. **Backend (Server)**: Built with Node.js, Express, and Socket.io.

### Files Overview

- `server.js` - The main backend server running the 30-second game loop, handling WebSockets, and processing bets.
- `package.json` - Node.js dependencies configuration.
- `index.html` *(To be created)* - Main Game Screen (Color Prediction, Period History, Bet Modal).
- `login.html` & `register.html` *(To be created)* - Authentication pages (Mobile/Email login, Withdraw Password).
- `admin.html` *(To be created)* - Admin Panel to view active bets and force winning results.

---

## Backend Setup & Execution

Follow these steps to run the backend server locally.

### 1. Install Dependencies
Open your terminal inside the `888.lk` folder and run:
```bash
npm install
```
*(This will install express, socket.io, and cors based on the package.json file)*

### 2. Start the Server
Run the following command to start the master clock and WebSocket server:
```bash
npm start
```
You should see terminal output confirming that the server is running on port 3000 and the 30-second master clock has been initialized.

---

## Game Logic Overview

1. **Master Clock**: The server runs a continuous 30-second loop. `time_left` is broadcasted to all frontend clients every second.
2. **Betting**: Users can submit bets via WebSockets while `time_left > 0`.
3. **Freeze Phase**: When `time_left == 0`, betting is frozen (`betting_frozen` event).
4. **Resolution**: The server automatically calculates the winning color/number, updates the user's balance in the database, and broadcasts the `period_result`.
5. **Admin Override**: Administrators can use the `/api/admin/force-result` endpoint to manually set the winning outcome before the clock hits zero.
