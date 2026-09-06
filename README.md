# LXZ MODZ WhatsApp Bot

Bot de moderación para grupos de WhatsApp con panel web separado. Usa Baileys para la conexión de WhatsApp Web mediante código de vinculación.

## Importante

Este proyecto usa una librería no oficial de WhatsApp Web. WhatsApp puede desconectar o limitar una cuenta automatizada. Usa un número dedicado con autorización del propietario y nunca publiques la carpeta `auth_info_baileys` ni variables secretas.

El almacenamiento local de Render Free es efímero y el servicio puede dormir. Por eso esta configuración sirve para pruebas; para una sesión estable se necesita una máquina que permanezca encendida y almacenamiento persistente.

## Ejecutar localmente

```bash
npm install
cp .env.example .env
npm start
```

Abre `http://localhost:3000/health` para comprobar el servidor.

## API

- `GET /health` — estado del servidor y WhatsApp.
- `POST /api/whatsapp/pairing-code` con `{ "phoneNumber": "51903513077" }` — solicita código real sin `+`, espacios ni guiones.
- `GET /api/whatsapp/status` — estado de la sesión.
- `GET /api/whatsapp/groups` — grupos detectados después de conectar.
- `POST /api/whatsapp/groups/:jid/config` — guarda `{ "enabled": true, "antilink": true, "adminOnly": true }`.
- `POST /api/whatsapp/logout` — cierra la sesión y elimina las credenciales locales.

## Vincular

1. Inicia el servidor.
2. En el panel introduce el número internacional sin símbolos.
3. Pulsa generar código.
4. En WhatsApp: Ajustes → Dispositivos vinculados → Vincular con el número de teléfono.
5. Escribe el código mostrado.
6. Después de `connected`, consulta los grupos y selecciona uno.

## Comandos disponibles

`/bot on`, `/bot off`, `/menu`, `/cmd`, `/status`, `/ban @usuario`, `/kick @usuario`, `/warn @usuario`, `/warnings @usuario`, `/resetwarn @usuario`, `/mute @usuario`, `/antilink on`, `/antilink off`, `/antiflood on`, `/antiflood off`, `/botadmin on`, `/botadmin off`, `/rules`.

Solo los administradores del grupo pueden ejecutar acciones de administración. El número conectado debe ser administrador del grupo para expulsar o cambiar participantes.
