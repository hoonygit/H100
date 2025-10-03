

export enum ConnectionStatus {
  DISCONNECTED,
  SCANNING,
  CONNECTING,
  CONNECTED,
  ERROR,
}

export interface SavedDataRecord {
  id: number;
  timestamp: string;
  fruitIndex: number;
  temperature: number;
  treeNo: number;
  defectCode: number;
  calcResult: number[];
}

// FIX: Add minimal Web Bluetooth type definitions to the global scope to make the TypeScript compiler aware of this experimental API.
declare global {
  interface Navigator {
    bluetooth: {
      requestDevice(options?: RequestDeviceOptions): Promise<BluetoothDevice>;
    };
  }

  interface RequestDeviceOptions {
    filters?: { name?: string; namePrefix?: string }[];
    optionalServices?: string[];
  }

  interface BluetoothDevice extends EventTarget {
    name?: string;
    gatt?: BluetoothRemoteGATTServer;
    addEventListener(
      type: 'gattserverdisconnected',
      listener: (this: this, ev: Event) => any,
    ): void;
    removeEventListener(
      type: 'gattserverdisconnected',
      listener: (this: this, ev: Event) => any,
    ): void;
  }

  interface BluetoothRemoteGATTServer {
    connected: boolean;
    connect(): Promise<BluetoothRemoteGATTServer>;
    disconnect(): void;
    getPrimaryService(serviceUUID: string): Promise<BluetoothRemoteGATTService>;
  }

  interface BluetoothRemoteGATTService {
    getCharacteristic(
      characteristicUUID: string,
    ): Promise<BluetoothRemoteGATTCharacteristic>;
  }

  interface BluetoothRemoteGATTCharacteristic extends EventTarget {
    value?: DataView;
    startNotifications(): Promise<void>;
    addEventListener(
      type: 'characteristicvaluechanged',
      listener: (event: Event) => void,
    ): void;
    writeValueWithoutResponse(value: BufferSource): Promise<void>;
    writeValue(value: BufferSource): Promise<void>;
  }
}
