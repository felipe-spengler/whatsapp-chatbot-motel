require('dotenv').config();
const db = require('./src/db_service');

async function dump() {
    try {
        console.log("=== DUMPING DB PRICES ===");
        const rooms = await db.getFullRoomsStatus();
        const periods = await db.getPricingPeriods();

        console.log("\n--- QUARTOS (Primeiro de cada tipo) ---");
        const typesSeen = new Set();
        rooms.forEach(r => {
            if (!typesSeen.has(r.tipoquarto)) {
                console.log(`Tipo: ${r.tipoquarto} | 1h(valorquarto): ${r.valorquarto} | Pernoite: ${r.pernoitequarto} | Extra(adicional): ${r.adicional}`);
                typesSeen.add(r.tipoquarto);
            }
        });

        console.log("\n--- PERIODOS_QUARTO ---");
        periods.forEach(p => {
            console.log(`Quarto ${p.numeroquarto} (${p.tipoquarto}) | Desc: ${p.descricao} | Valor: ${p.valor} | IsPernoite: ${p.is_pernoite}`);
        });

        process.exit(0);
    } catch (err) {
        console.error(err);
        process.exit(1);
    }
}

dump();
