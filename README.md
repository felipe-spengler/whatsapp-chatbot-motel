# WhatsApp Chatbot para Motel Intensy 🏨🤖

Automação de atendimento via WhatsApp para o Motel Intensy, utilizando **WPPConnect** e **Gemini AI (Google)**.

## 🚀 Funcionalidades
- **Atendimento com IA**: Persona charmosamente discreta e profissional.
- **Fluxo de Reserva**: Coleta automática de Suíte, Data/Hora, Período e Pessoas.
- **Notificações**: Avisa a gerência via WhatsApp quando uma reserva é iniciada.
- **Dashboard Admin**: Painel para conexão via QR Code e monitoramento de status.
- **Docker Ready**: Configuração completa para deploy via Docker ou Coolify.

## 🛠️ Tecnologias
- Node.js
- WPPConnect
- Google Gemini AI (v1 API)
- Express & Socket.io
- Tailwind CSS

## ⚙️ Configuração
1. Renomeie `.env.example` para `.env`.
2. Insira sua `GEMINI_API_KEY`.
3. Configure o `NOTIFICATION_NUMBER` (número que receberá os avisos).

## 🐳 Deploy (Coolify/Docker)
O projeto já contém `Dockerfile` e `docker-compose.yml`.
No Coolify:
1. Selecione o repositório.
2. Configure a porta de destino como **3001**.
3. Adicione as variáveis de ambiente do `.env`.

---
Desenvolvido por Inprolink.
