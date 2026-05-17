import { useEffect, useRef, useState, useCallback } from 'react';
import { io, Socket } from 'socket.io-client';

const API_URL = process.env.NEXT_PUBLIC_API_URL || 'http://localhost:3001';

interface SocketState {
  isConnected: boolean;
  lastSignal: any | null;
  lastPosition: any | null;
  replayCandle: any | null;
  replayTrade: any | null;
}

export function useSocket() {
  const socketRef = useRef<Socket | null>(null);
  const [state, setState] = useState<SocketState>({
    isConnected: false,
    lastSignal: null,
    lastPosition: null,
    replayCandle: null,
    replayTrade: null,
  });

  useEffect(() => {
    const socket = io(API_URL, {
      transports: ['websocket', 'polling'],
      reconnectionDelay: 1000,
      reconnectionAttempts: 10,
    });

    socketRef.current = socket;

    socket.on('connect', () => {
      setState((s) => ({ ...s, isConnected: true }));
    });

    socket.on('disconnect', () => {
      setState((s) => ({ ...s, isConnected: false }));
    });

    socket.on('signal', (signal: any) => {
      setState((s) => ({ ...s, lastSignal: signal }));
    });

    socket.on('position_opened', (position: any) => {
      setState((s) => ({ ...s, lastPosition: position }));
    });

    socket.on('position_closed', (data: any) => {
      setState((s) => ({ ...s, lastPosition: data.position }));
    });

    socket.on('replay_candle', (data: any) => {
      setState((s) => ({ ...s, replayCandle: data }));
    });

    socket.on('replay_trade', (trade: any) => {
      setState((s) => ({ ...s, replayTrade: trade }));
    });

    return () => {
      socket.disconnect();
    };
  }, []);

  const subscribe = useCallback((pair: string) => {
    socketRef.current?.emit('subscribe', pair);
  }, []);

  return { ...state, subscribe, socket: socketRef.current };
}
