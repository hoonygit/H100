

import React, { useState, useCallback, useEffect, useRef } from 'react';
import { ConnectionStatus, SavedDataRecord } from './types';
import { UART_SERVICE_UUID, UART_TX_CHARACTERISTIC_UUID, UART_RX_CHARACTERISTIC_UUID } from './constants';
import { BluetoothIcon, SpinnerIcon, SendIcon } from './components/icons';

const App: React.FC = () => {
    const [status, setStatus] = useState<ConnectionStatus>(ConnectionStatus.DISCONNECTED);
    const [device, setDevice] = useState<BluetoothDevice | null>(null);
    const [receivedMessages, setReceivedMessages] = useState<string[]>([]);
    const [errorMessage, setErrorMessage] = useState<string | null>(null);
    const [parsedData, setParsedData] = useState<SavedDataRecord[]>([]);
    const [isFetchingData, setIsFetchingData] = useState(false);
    
    const txCharacteristicRef = useRef<BluetoothRemoteGATTCharacteristic | null>(null);
    const rxCharacteristicRef = useRef<BluetoothRemoteGATTCharacteristic | null>(null);
    const textDecoder = new TextDecoder();

    const resetState = useCallback(() => {
        setStatus(ConnectionStatus.DISCONNECTED);
        setDevice(null);
        setReceivedMessages([]);
        setParsedData([]);
        setIsFetchingData(false);
        txCharacteristicRef.current = null;
        rxCharacteristicRef.current = null;
    }, []);
    
    const handleSendCommand = useCallback(async (command: Uint8Array) => {
        if (!txCharacteristicRef.current) {
            console.error('TX characteristic not available.');
            setErrorMessage('TX characteristic not available.');
            setStatus(ConnectionStatus.ERROR);
            return;
        }
        try {
            await txCharacteristicRef.current.writeValueWithoutResponse(command);
            const commandHex = Array.from(command).map(b => b.toString(16).padStart(2, '0').toUpperCase()).join(' ');
            setReceivedMessages(prev => [...prev, `[CMD] ${commandHex}`]);
        } catch (error) {
            console.error('Failed to send command:', error);
            setErrorMessage('Failed to send command.');
            setStatus(ConnectionStatus.ERROR);
        }
    }, []);

    const handleSaveDataResponse = useCallback((dataView: DataView) => {
        const payloadLength = dataView.getUint16(2, true); // Little-Endian
        if (payloadLength === 0) {
            setReceivedMessages(prev => [...prev, '[INFO] Received empty data packet. Fetch complete.']);
            setIsFetchingData(false);
            return;
        }

        const RECORD_SIZE = 43;
        const numRecords = Math.floor(payloadLength / RECORD_SIZE);
        const newRecords: SavedDataRecord[] = [];
        let isLastPacket = false;

        for (let i = 0; i < numRecords; i++) {
            const offset = 4 + i * RECORD_SIZE;
            const fruitIndex = dataView.getUint8(offset);

            if (fruitIndex === 0) {
                isLastPacket = true;
                break; 
            }

            const year = dataView.getUint8(offset + 1) + 2000;
            const month = dataView.getUint8(offset + 2);
            const day = dataView.getUint8(offset + 3);
            const hour = dataView.getUint8(offset + 4);
            const minute = dataView.getUint8(offset + 5);
            const second = dataView.getUint8(offset + 6);
            const timestamp = new Date(year, month - 1, day, hour, minute, second).toLocaleString();
            
            const temperature = dataView.getFloat32(offset + 7, true);
            const treeNo = dataView.getUint16(offset + 15, true);
            const defectCode = dataView.getUint16(offset + 21, true);
            
            const calcResult: number[] = [];
            for (let j = 0; j < 5; j++) {
                calcResult.push(dataView.getFloat32(offset + 23 + (j * 4), true));
            }

            newRecords.push({
                id: Date.now() + i,
                timestamp,
                fruitIndex,
                temperature,
                treeNo,
                defectCode,
                calcResult,
            });
        }

        if (newRecords.length > 0) {
            setParsedData(prev => [...prev, ...newRecords]);
        }

        setReceivedMessages(prev => [...prev, `[INFO] Received ${newRecords.length} data records.`]);

        if (isLastPacket || numRecords < 50) {
            setReceivedMessages(prev => [...prev, '[INFO] All data received.']);
            setIsFetchingData(false);
        } else {
            const command = new Uint8Array([0xAE, 0x5B, 0x00, 0x00]); // SAVE_DAT_NEXT_REQ
            handleSendCommand(command);
        }
    }, [handleSendCommand]);

    const handleNotifications = useCallback((event: Event) => {
        const target = event.target as BluetoothRemoteGATTCharacteristic;
        const value = target.value;
        if (!value) return;

        const dataView = new DataView(value.buffer);
        if (dataView.byteLength < 2) return;

        const som = dataView.getUint8(0);
        const command = dataView.getUint8(1);

        if (som === 0xAE && command === 0xDA) { // SAVE_DAT_REP
            handleSaveDataResponse(dataView);
        } else {
            // Fallback for non-protocol or other messages
            const message = textDecoder.decode(value);
            console.log('Received:', message);
            const packetHex = Array.from(new Uint8Array(value.buffer)).map(b => b.toString(16).padStart(2, '0').toUpperCase()).join(' ');
            setReceivedMessages(prev => [...prev, `[IN] ${packetHex} (${message})`]);
        }
    }, [textDecoder, handleSaveDataResponse]);
    
    const onDisconnected = useCallback(() => {
        console.log('Device disconnected.');
        resetState();
    }, [resetState]);

    useEffect(() => {
        return () => {
            if (device) {
                device.removeEventListener('gattserverdisconnected', onDisconnected);
                device.gatt?.disconnect();
            }
        };
    }, [device, onDisconnected]);


    const handleScanAndConnect = async () => {
        if (!navigator.bluetooth) {
            setErrorMessage('Web Bluetooth API is not available on this browser. Please use Chrome on desktop or Android.');
            setStatus(ConnectionStatus.ERROR);
            return;
        }

        setStatus(ConnectionStatus.SCANNING);
        setErrorMessage(null);
        
        try {
            console.log('Requesting Bluetooth device...');
            const selectedDevice = await navigator.bluetooth.requestDevice({
                filters: [
                    { name: 'H100' },
                    { namePrefix: 'H' }
                ],
                optionalServices: [UART_SERVICE_UUID]
            });

            const deviceName = selectedDevice.name || '';
            console.log(`User selected device: ${deviceName}`);
            
            const isH100 = deviceName === 'H100';
            const isHxxxxP = deviceName.length >= 6 && deviceName.startsWith('H') && deviceName[5].toUpperCase() === 'P';

            if (!isH100 && !isHxxxxP) {
                throw new Error(`Device '${deviceName}' does not match the required name pattern (H100 or HxxxxP...).`);
            }
            
            setStatus(ConnectionStatus.CONNECTING);
            setDevice(selectedDevice);

            selectedDevice.addEventListener('gattserverdisconnected', onDisconnected);

            console.log('Connecting to GATT server...');
            const server = await selectedDevice.gatt?.connect();
            if (!server) throw new Error('Could not connect to GATT server.');

            console.log('Getting primary service...');
            const service = await server.getPrimaryService(UART_SERVICE_UUID);

            console.log('Getting characteristics...');
            const txChar = await service.getCharacteristic(UART_TX_CHARACTERISTIC_UUID);
            const rxChar = await service.getCharacteristic(UART_RX_CHARACTERISTIC_UUID);

            txCharacteristicRef.current = txChar;
            rxCharacteristicRef.current = rxChar;
            
            console.log('Starting notifications...');
            await rxChar.startNotifications();
            rxChar.addEventListener('characteristicvaluechanged', handleNotifications);

            setStatus(ConnectionStatus.CONNECTED);
            console.log('Successfully connected!');

        } catch (error) {
            let message = 'An unknown error occurred.';
            if (error instanceof Error) {
                message = error.message.includes('User cancelled') ? 'Device selection cancelled.' : error.message;
            }
            setErrorMessage(message);
            setStatus(ConnectionStatus.ERROR);
            resetState();
        }
    };

    const handleDisconnect = () => {
        if (device?.gatt?.connected) {
            device.gatt.disconnect();
        } else {
            resetState();
        }
    };

    const handleSendText = async (message: string) => {
        const textEncoder = new TextEncoder();
        const command = textEncoder.encode(message);
         if (!txCharacteristicRef.current) {
            console.error('TX characteristic not available.');
            return;
        }
        try {
            await txCharacteristicRef.current.writeValue(command);
            setReceivedMessages(prev => [...prev, `[OUT] ${message}`]);
        } catch (error) {
            console.error('Failed to send message:', error);
            setErrorMessage('Failed to send message.');
            setStatus(ConnectionStatus.ERROR);
        }
    };

    const handleFetchSavedData = () => {
        setParsedData([]);
        setIsFetchingData(true);
        setReceivedMessages(prev => [...prev, '[INFO] Requesting saved data...']);
        const command = new Uint8Array([0xAE, 0x5A, 0x00, 0x00]); // SAVE_DAT_REQ
        handleSendCommand(command);
    };

    const renderContent = () => {
        switch (status) {
            case ConnectionStatus.SCANNING:
            case ConnectionStatus.CONNECTING:
                return <ConnectingScreen deviceName={device?.name} status={status} />;
            case ConnectionStatus.CONNECTED:
                return <ControlPanel 
                            deviceName={device?.name || 'Unknown Device'} 
                            onSendMessage={handleSendText} 
                            onDisconnect={handleDisconnect} 
                            messages={receivedMessages}
                            onFetchData={handleFetchSavedData}
                            isFetchingData={isFetchingData}
                            parsedData={parsedData}
                        />;
            case ConnectionStatus.ERROR:
                return <ErrorScreen message={errorMessage} onRetry={handleScanAndConnect} />;
            case ConnectionStatus.DISCONNECTED:
            default:
                return <ScanScreen onScan={handleScanAndConnect} />;
        }
    };

    return (
        <main className="min-h-screen w-full flex items-center justify-center p-4 bg-slate-900 text-slate-100 font-sans">
            <div className="w-full max-w-2xl bg-slate-800 rounded-2xl shadow-2xl p-6 border border-slate-700">
                <header className="flex items-center gap-4 mb-6">
                    <div className="p-2 bg-sky-500/20 rounded-lg text-sky-400">
                        <BluetoothIcon className="w-8 h-8"/>
                    </div>
                    <div>
                        <h1 className="text-2xl font-bold text-white">BLE Communicator</h1>
                        <p className="text-sm text-slate-400">H-100 Protocol Interface</p>
                    </div>
                </header>
                {renderContent()}
            </div>
        </main>
    );
};

const ScanScreen: React.FC<{ onScan: () => void }> = ({ onScan }) => (
    <div className="text-center">
        <p className="text-slate-300 mb-6">Click below to scan for compatible Bluetooth devices. In the popup, please select a device with a name like "H100" or one starting with 'H' and having 'P' as the 6th character.</p>
        <button
            onClick={onScan}
            className="w-full bg-sky-500 hover:bg-sky-600 text-white font-bold py-3 px-4 rounded-lg transition-all duration-300 transform hover:scale-105 focus:outline-none focus:ring-2 focus:ring-sky-400 focus:ring-opacity-75"
        >
            Scan for Devices
        </button>
    </div>
);

const ConnectingScreen: React.FC<{ deviceName?: string; status: ConnectionStatus }> = ({ deviceName, status }) => (
    <div className="flex flex-col items-center justify-center text-center h-48">
        <SpinnerIcon className="w-12 h-12 text-sky-400 mb-4" />
        <h2 className="text-xl font-semibold text-white">
            {status === ConnectionStatus.CONNECTING ? `Connecting to ${deviceName || 'device'}...` : 'Waiting for device selection...'}
        </h2>
        <p className="text-slate-400">Please approve the connection request.</p>
    </div>
);

const ErrorScreen: React.FC<{ message: string | null; onRetry: () => void }> = ({ message, onRetry }) => (
    <div className="text-center">
        <h2 className="text-xl font-semibold text-red-400 mb-2">Connection Failed</h2>
        <p className="text-slate-300 bg-slate-700/50 p-3 rounded-lg mb-6 break-words">{message || 'An unexpected error occurred.'}</p>
        <button
            onClick={onRetry}
            className="w-full bg-slate-600 hover:bg-slate-700 text-white font-bold py-3 px-4 rounded-lg transition-colors"
        >
            Try Again
        </button>
    </div>
);

const DataTable: React.FC<{ data: SavedDataRecord[] }> = ({ data }) => (
    <div className="h-64 bg-slate-900 rounded-lg overflow-y-auto border border-slate-700 relative">
        <table className="w-full text-sm text-left text-slate-400">
            <thead className="text-xs text-slate-300 uppercase bg-slate-800 sticky top-0 z-10">
                <tr>
                    <th scope="col" className="px-4 py-2">Timestamp</th>
                    <th scope="col" className="px-4 py-2 text-center">Tree #</th>
                    <th scope="col" className="px-4 py-2 text-center">Temp (°C)</th>
                    <th scope="col" className="px-4 py-2">Results (1-5)</th>
                </tr>
            </thead>
            <tbody className="divide-y divide-slate-800">
                {data.map(record => (
                    <tr key={record.id} className="bg-slate-900 hover:bg-slate-700/50">
                        <td className="px-4 py-2 font-mono whitespace-nowrap">{record.timestamp}</td>
                        <td className="px-4 py-2 text-center font-mono">{record.treeNo}</td>
                        <td className="px-4 py-2 text-center font-mono">{record.temperature.toFixed(2)}</td>
                        <td className="px-4 py-2 font-mono text-xs">
                            {record.calcResult.map(r => r.toFixed(2)).join(', ')}
                        </td>
                    </tr>
                ))}
            </tbody>
        </table>
    </div>
);


interface ControlPanelProps {
    deviceName: string;
    onSendMessage: (message: string) => void;
    onDisconnect: () => void;
    messages: string[];
    onFetchData: () => void;
    isFetchingData: boolean;
    parsedData: SavedDataRecord[];
}
const ControlPanel: React.FC<ControlPanelProps> = ({ deviceName, onSendMessage, onDisconnect, messages, onFetchData, isFetchingData, parsedData }) => {
    const [message, setMessage] = useState('');
    const messagesEndRef = useRef<HTMLDivElement | null>(null);

    const scrollToBottom = () => {
        messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
    }

    useEffect(scrollToBottom, [messages]);
    
    const handleSubmit = (e: React.FormEvent) => {
        e.preventDefault();
        if (message.trim()) {
            onSendMessage(message);
            setMessage('');
        }
    };

    return (
        <div>
            <div className="flex justify-between items-center mb-4">
                <div>
                    <p className="text-xs text-slate-400">Connected to</p>
                    <h2 className="text-lg font-bold text-white">{deviceName}</h2>
                </div>
                <button
                    onClick={onDisconnect}
                    className="bg-red-500/20 hover:bg-red-500/40 text-red-400 font-semibold py-2 px-4 rounded-lg text-sm transition-colors"
                >
                    Disconnect
                </button>
            </div>

            <div className="space-y-6">
                <div>
                     <button
                        onClick={onFetchData}
                        disabled={isFetchingData}
                        className="w-full flex items-center justify-center gap-2 bg-indigo-500 hover:bg-indigo-600 text-white font-bold py-3 px-4 rounded-lg transition-all duration-300 transform hover:scale-105 focus:outline-none focus:ring-2 focus:ring-indigo-400 focus:ring-opacity-75 disabled:bg-slate-600 disabled:cursor-not-allowed disabled:scale-100"
                    >
                        {isFetchingData && <SpinnerIcon className="w-5 h-5"/>}
                        {isFetchingData ? 'Fetching Data...' : 'Get Saved Data'}
                    </button>
                </div>

                {(isFetchingData && parsedData.length === 0) && (
                    <div className="flex flex-col items-center justify-center text-center my-4">
                        <SpinnerIcon className="w-8 h-8 text-indigo-400 mb-2" />
                        <p className="text-slate-400">Receiving and parsing data from device...</p>
                    </div>
                )}
                
                {parsedData.length > 0 && (
                    <div>
                        <h3 className="text-sm font-semibold text-slate-300 mb-2">Saved Measurement Data ({parsedData.length} records)</h3>
                        <DataTable data={parsedData} />
                    </div>
                )}
                
                <div>
                    <h3 className="text-sm font-semibold text-slate-300 mb-2">Raw Data Log</h3>
                    <div className="h-48 bg-slate-900 rounded-lg p-3 overflow-y-auto font-mono text-sm text-slate-200 border border-slate-700">
                        {messages.map((msg, index) => (
                            <p key={index} className={msg.startsWith('[OUT]') ? 'text-sky-400' : msg.startsWith('[CMD]') ? 'text-amber-400' : 'text-lime-400'}>{msg}</p>
                        ))}
                        <div ref={messagesEndRef} />
                    </div>
                </div>
                
                <form onSubmit={handleSubmit}>
                    <h3 className="text-sm font-semibold text-slate-300 mb-2">Send Text Message</h3>
                    <div className="flex gap-2">
                        <input
                            type="text"
                            value={message}
                            onChange={(e) => setMessage(e.target.value)}
                            placeholder="Type message here..."
                            className="flex-grow bg-slate-700 border border-slate-600 text-white rounded-lg px-3 py-2 focus:outline-none focus:ring-2 focus:ring-sky-500"
                        />
                        <button
                            type="submit"
                            className="bg-sky-500 hover:bg-sky-600 text-white font-bold p-3 rounded-lg transition-colors flex items-center justify-center disabled:opacity-50 disabled:cursor-not-allowed"
                            disabled={!message.trim()}
                        >
                            <SendIcon className="w-5 h-5"/>
                        </button>
                    </div>
                </form>
            </div>
        </div>
    );
};

export default App;