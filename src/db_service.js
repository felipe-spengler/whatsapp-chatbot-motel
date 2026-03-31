const mysql = require('mysql2/promise');
require('dotenv').config();

const pool = mysql.createPool({
    host: process.env.REMOTE_DB_HOST,
    user: process.env.REMOTE_DB_USER,
    password: process.env.REMOTE_DB_PASS,
    database: process.env.REMOTE_DB_NAME,
    waitForConnections: true,
    connectionLimit: 10,
    queueLimit: 0
});

/**
 * Check room availability and pricing
 * @returns {Promise<Array>} List of rooms with their status and pricing
 */
async function getFullRoomsStatus() {
    try {
        const query = `
            SELECT 
                q.numeroquarto, 
                q.tipoquarto, 
                q.valorquarto, 
                q.pernoitequarto, 
                q.addPessoa,
                s.atualquarto as status,
                s.horastatus,
                s.periodo
            FROM quartos q
            LEFT JOIN status s ON q.numeroquarto = s.numeroquarto
        `;
        const [rows] = await pool.query(query);
        return rows;
    } catch (error) {
        console.error('Error fetching full room status:', error.message);
        throw error;
    }
}

/**
 * Check specifically if a type of room is available
 * @param {string} type - 'Apartamento Standard', 'Suite Intensy', etc.
 */
async function checkAvailabilityByType(type) {
    try {
        const rooms = await getFullRoomsStatus();
        if (type) {
            return rooms.filter(r => r.tipoquarto.toLowerCase().includes(type.toLowerCase()));
        }
        return rooms;
    } catch (error) {
        console.error('Error checking availability by type:', error.message);
        return [];
    }
}

/**
 * Get status of a specific room number
 * @param {number} roomNumber 
 */
async function getRoomStatus(roomNumber) {
    try {
        const [rows] = await pool.query(`
            SELECT 
                q.numeroquarto, 
                q.tipoquarto, 
                q.valorquarto, 
                q.pernoitequarto, 
                s.atualquarto as status
            FROM quartos q
            LEFT JOIN status s ON q.numeroquarto = s.numeroquarto
            WHERE q.numeroquarto = ?
        `, [roomNumber]);
        return rows[0];
    } catch (error) {
        console.error('Error fetching room status:', error.message);
        return null;
    }
}

module.exports = { 
    pool, 
    getFullRoomsStatus, 
    checkAvailabilityByType, 
    getRoomStatus 
};
