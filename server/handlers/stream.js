function group_handler(io, socket, rooms, context, config) {
    socket.on('store_rtp_capabilities', (data, callback) => {
        try {
            const room = rooms[context.roomId];
            const clientData = room.clients.get(context.account_uuid);
            if (clientData) {
                clientData.rtpCapabilities = data.rtpCapabilities;
            }
            callback({ result: true, data: null });
        } catch (err) {
            console.error(`[ERROR] in 'store_rtp_capabilities' handler:`, err);
            if (err instanceof Error) {
                console.error(err.stack);
            }
            callback({ result: false, data: err.message });
        }
    });
    socket.on('create_transport', async (data, callback) => {
        try {
            const room = rooms[context.roomId];
            if (!room) return callback({ result: false, data: 'Not in a room' });

            const transport = await room.router.createWebRtcTransport({
                ...config.webRtcTransport,
                listenIps: config.webRtcTransport.listenIps.map(ip => ({ ...ip, announcedIp: ip.announcedIp || config.domain })),
                enableSctp: true,
                enableUdp: true,
                enableTcp: true,
            });

            const clientData = room.clients.get(context.account_uuid);
            clientData.transports.set(transport.id, transport);
            const res_k = {
                id: transport.id,
                iceParameters: transport.iceParameters,
                iceCandidates: transport.iceCandidates,
                dtlsParameters: transport.dtlsParameters,
                sctpParameters: transport.sctpParameters,
            }
            callback({
                result: true,
                data: res_k
            });
        } catch (error) {
            console.error(`[ERROR] in 'create_transport' handler:`, error);
            if (error instanceof Error) {
                console.error(error.stack);
            }
            callback({ result: false, data: error.message });
        }
    });
    socket.on('connect_transport', async (data, callback) => {
        try {
            const { transportId, dtlsParameters } = data;
            const room = rooms[context.roomId];
            const clientData = room.clients.get(context.account_uuid);
            if (!room || !clientData) return callback({ result: false, data: 'Not in a room' });

            const transport = clientData.transports.get(transportId);
            if (!transport) return callback({ result: false, data: 'Transport not found' });
            console.log(`[conntect_transport] roomId: ${context.roomId} clientId: ${context.clientId}`);
            await transport.connect({ dtlsParameters });
            callback({ result: true, data: null });
        } catch (error) {
            console.error(`[ERROR] in 'connect_transport' handler:`, error);
            if (error instanceof Error) {
                console.error(error.stack);
            }
            callback({ result: false, data: error.message });
        }
    });
    socket.on('produce', async (data, callback) => {
        try {
            const { transportId, kind, rtpParameters } = data;
            const room = rooms[context.roomId];
            const clientData = room.clients.get(context.account_uuid);
            if (!room || !clientData) return callback({ result: false, data: 'Not in a room' });

            const transport = clientData.transports.get(transportId);
            if (!transport) return callback({ result: false, data: 'Transport not found' });

            const producer = await transport.produce({ kind, rtpParameters });
            clientData.producers.set(producer.id, producer);

            producer.on('transportclose', () => {
                console.log(`Producer's transport closed: ${producer.id}`);
                clientData.producers.delete(producer.id);
            });

            callback({ result: true, data: { id: producer.id } });
        } catch (error) {
            console.error(`[ERROR] in 'produce' handler:`, error);
            if (error instanceof Error) {
                console.error(error.stack);
            }
            callback({ result: false, data: error.message });
        }
    });
    socket.on('consume', async (data, callback) => {
        try {
            const { producerId, transportId } = data;
            const room = rooms[context.roomId];
            const clientData = room.clients.get(context.account_uuid);
            if (!room || !clientData) return callback({ result: false, data: 'Not in a room' });

            const transport = clientData.transports.get(transportId);
            if (!transport) return callback({ result: false, data: 'Transport not found' });

            if (!room.router.canConsume({ producerId, rtpCapabilities: clientData.rtpCapabilities })) {
                return callback({ result: false, data: 'Cannot consume this producer' });
            }

            const consumer = await transport.consume({
                producerId,
                rtpCapabilities: clientData.rtpCapabilities,
                paused: true,
            });
            clientData.consumers.set(consumer.id, consumer);

            consumer.on('transportclose', () => {
                clientData.consumers.delete(consumer.id);
            });
            consumer.on('producerclose', () => {
                clientData.consumers.delete(consumer.id);
            });

            callback({
                result: true,
                data: {
                    id: consumer.id,
                    producerId,
                    kind: consumer.kind,
                    rtpParameters: consumer.rtpParameters,
                }
            });
        } catch (error) {
            console.error(`[ERROR] in 'consume' handler:`, error);
            if (error instanceof Error) {
                console.error(error.stack);
            }
            callback({ result: false, data: error.message });
        }
    });

    socket.on('resume_consumer', async (data, callback) => {
        try {
            const { consumerId } = data;
            const room = rooms[context.roomId];
            const clientData = room.clients.get(context.account_uuid);
            const consumer = clientData.consumers.get(consumerId);
            if (consumer) {
                await consumer.resume();
            }
            callback({ result: true, data: null });
        } catch (err) {
            console.error(`[ERROR] in 'resume_consumer' handler:`, err);
            if (err instanceof Error) {
                console.error(err.stack);
            }
            callback({ result: false, data: err.message });
        }
    });
}
export default group_handler;