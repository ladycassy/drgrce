import { useState, useEffect } from 'react';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Label } from '@/components/ui/label';
import { Input } from '@/components/ui/input';
import { Switch } from '@/components/ui/switch';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Textarea } from '@/components/ui/textarea';
import { Badge } from '@/components/ui/badge';
import { Shield, Globe, Clock, Hash, Info } from 'lucide-react';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip';

interface VPNConfig {
  enabled: boolean;
  clientType: 'nordvpn' | 'windscribe' | 'manual';
  command: string;
  connectionVerifyUrl: string;
  ipTrackingEndpoint: string;
  connectionVerifyTimeout: number;
  maxRetries: number;
  retryDelay: number;
  changeAfterFailures: number;
  rotationStrategy: 'manual' | 'time' | 'count' | 'adaptive';
  rotationCount: number;
  rotationIntervalMs: number;
  serverList: string[];
}

const defaultConfig: VPNConfig = {
  enabled: false,
  clientType: 'manual',
  command: 'nordvpn',
  connectionVerifyUrl: 'https://www.google.com',
  ipTrackingEndpoint: 'https://api.ipify.org?format=json',
  connectionVerifyTimeout: 5000,
  maxRetries: 10,
  retryDelay: 2000,
  changeAfterFailures: 5,
  rotationStrategy: 'adaptive',
  rotationCount: 500,
  rotationIntervalMs: 3600000,
  serverList: [],
};

interface VPNConfigPanelProps {
  config?: VPNConfig;
  onChange?: (config: VPNConfig) => void;
  disabled?: boolean;
}

export function VPNConfigPanel({ config = defaultConfig, onChange, disabled = false }: VPNConfigPanelProps) {
  const [localConfig, setLocalConfig] = useState<VPNConfig>(config);

  useEffect(() => {
    setLocalConfig(config);
  }, [config]);

  const handleChange = (updates: Partial<VPNConfig>) => {
    const newConfig = { ...localConfig, ...updates };
    setLocalConfig(newConfig);
    onChange?.(newConfig);
  };

  const handleServerListChange = (value: string) => {
    const servers = value.split('\n').filter(s => s.trim().length > 0);
    handleChange({ serverList: servers });
  };

  return (
    <Card className="w-full">
      <CardHeader>
        <div className="flex items-center gap-2">
          <Shield className="h-5 w-5 text-blue-500" />
          <CardTitle>VPN IP Rotation</CardTitle>
        </div>
        <CardDescription>
          Configure automatic IP rotation using NordVPN or Windscribe to avoid rate limiting
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-6">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <Label htmlFor="vpn-enabled">Enable VPN Rotation</Label>
            {localConfig.enabled && (
              <Badge variant="outline" className="bg-green-50 text-green-700 border-green-200">
                Active
              </Badge>
            )}
          </div>
          <Switch
            id="vpn-enabled"
            checked={localConfig.enabled}
            onCheckedChange={(enabled) => handleChange({ enabled })}
            disabled={disabled}
          />
        </div>

        {localConfig.enabled && (
          <>
            <div className="space-y-4 pt-4 border-t">
              <div className="grid gap-4 sm:grid-cols-2">
                <div className="space-y-2">
                  <Label htmlFor="vpn-client">VPN Client</Label>
                  <Select
                    value={localConfig.clientType}
                    onValueChange={(value) => handleChange({ 
                      clientType: value as VPNConfig['clientType'],
                      command: value === 'nordvpn' ? 'nordvpn' : value === 'windscribe' ? 'windscribe' : 'manual'
                    })}
                    disabled={disabled}
                  >
                    <SelectTrigger id="vpn-client">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="manual">Manual (Run commands yourself)</SelectItem>
                      <SelectItem value="nordvpn">NordVPN CLI</SelectItem>
                      <SelectItem value="windscribe">Windscribe CLI</SelectItem>
                    </SelectContent>
                  </Select>
                  <p className="text-xs text-muted-foreground">
                    {localConfig.clientType === 'manual' 
                      ? 'You will be prompted to change VPN manually'
                      : `Automatic rotation using ${localConfig.clientType} CLI`
                    }
                  </p>
                </div>

                {localConfig.clientType !== 'manual' && (
                  <div className="space-y-2">
                    <div className="flex items-center gap-2">
                      <Label htmlFor="vpn-command">CLI Command Path</Label>
                      <TooltipProvider>
                        <Tooltip>
                          <TooltipTrigger asChild>
                            <Info className="h-3 w-3 text-muted-foreground cursor-help" />
                          </TooltipTrigger>
                          <TooltipContent className="max-w-xs">
                            <p className="text-xs">
                              Path to the VPN CLI executable. Default is '{localConfig.clientType}' which works if it's in your PATH.
                              {localConfig.clientType === 'nordvpn' && ' On Linux: usually /usr/bin/nordvpn'}
                              {localConfig.clientType === 'windscribe' && ' On Windows: "C:\\Program Files\\Windscribe\\windscribe-cli.exe"'}
                            </p>
                          </TooltipContent>
                        </Tooltip>
                      </TooltipProvider>
                    </div>
                    <Input
                      id="vpn-command"
                      value={localConfig.command}
                      onChange={(e) => handleChange({ command: e.target.value })}
                      disabled={disabled}
                      placeholder={localConfig.clientType}
                    />
                  </div>
                )}
              </div>

              <div className="space-y-2">
                <div className="flex items-center gap-2">
                  <Globe className="h-4 w-4 text-blue-500" />
                  <Label htmlFor="rotation-strategy">Rotation Strategy</Label>
                </div>
                <Select
                  value={localConfig.rotationStrategy}
                  onValueChange={(value) => handleChange({ rotationStrategy: value as VPNConfig['rotationStrategy'] })}
                  disabled={disabled}
                >
                  <SelectTrigger id="rotation-strategy">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="manual">Manual - Only rotate when requested</SelectItem>
                    <SelectItem value="count">Count-based - After X scrapes</SelectItem>
                    <SelectItem value="time">Time-based - Every X minutes</SelectItem>
                    <SelectItem value="adaptive">Adaptive - Smart rotation (Recommended)</SelectItem>
                  </SelectContent>
                </Select>
                <p className="text-xs text-muted-foreground">
                  {localConfig.rotationStrategy === 'manual' && 'IP changes only when you request it'}
                  {localConfig.rotationStrategy === 'count' && 'Automatically rotate after a fixed number of scrapes'}
                  {localConfig.rotationStrategy === 'time' && 'Automatically rotate after a time interval'}
                  {localConfig.rotationStrategy === 'adaptive' && 'Combines count, time, and failure-based rotation for optimal performance'}
                </p>
              </div>

              {(localConfig.rotationStrategy === 'count' || localConfig.rotationStrategy === 'adaptive') && (
                <div className="space-y-2">
                  <div className="flex items-center gap-2">
                    <Hash className="h-4 w-4 text-blue-500" />
                    <Label htmlFor="rotation-count">Scrapes Before Rotation</Label>
                  </div>
                  <Input
                    id="rotation-count"
                    type="number"
                    min="1"
                    value={localConfig.rotationCount}
                    onChange={(e) => handleChange({ rotationCount: parseInt(e.target.value) || 500 })}
                    disabled={disabled}
                  />
                  <p className="text-xs text-muted-foreground">
                    Rotate IP after completing this many scrapes (0 to disable)
                  </p>
                </div>
              )}

              {(localConfig.rotationStrategy === 'time' || localConfig.rotationStrategy === 'adaptive') && (
                <div className="space-y-2">
                  <div className="flex items-center gap-2">
                    <Clock className="h-4 w-4 text-blue-500" />
                    <Label htmlFor="rotation-interval">Time Between Rotations (minutes)</Label>
                  </div>
                  <Input
                    id="rotation-interval"
                    type="number"
                    min="1"
                    value={Math.floor(localConfig.rotationIntervalMs / 60000)}
                    onChange={(e) => handleChange({ rotationIntervalMs: (parseInt(e.target.value) || 60) * 60000 })}
                    disabled={disabled}
                  />
                  <p className="text-xs text-muted-foreground">
                    Rotate IP after this many minutes (0 to disable)
                  </p>
                </div>
              )}

              {localConfig.rotationStrategy === 'adaptive' && (
                <div className="space-y-2">
                  <Label htmlFor="change-after-failures">Failures Before Rotation</Label>
                  <Input
                    id="change-after-failures"
                    type="number"
                    min="1"
                    value={localConfig.changeAfterFailures}
                    onChange={(e) => handleChange({ changeAfterFailures: parseInt(e.target.value) || 5 })}
                    disabled={disabled}
                  />
                  <p className="text-xs text-muted-foreground">
                    Rotate IP immediately after this many consecutive failures
                  </p>
                </div>
              )}

              <div className="space-y-2">
                <div className="flex items-center gap-2">
                  <Label htmlFor="server-list">Server List (Optional)</Label>
                  <TooltipProvider>
                    <Tooltip>
                      <TooltipTrigger asChild>
                        <Info className="h-3 w-3 text-muted-foreground cursor-help" />
                      </TooltipTrigger>
                      <TooltipContent className="max-w-xs">
                        <p className="text-xs">
                          Specify VPN servers to rotate through (one per line). 
                          For NordVPN: use country/city names like "United_States" or "us1234".
                          For Windscribe: use location names like "US Central" or "Canada East".
                          Leave empty for auto-selection.
                        </p>
                      </TooltipContent>
                    </Tooltip>
                  </TooltipProvider>
                </div>
                <Textarea
                  id="server-list"
                  placeholder={
                    localConfig.clientType === 'nordvpn'
                      ? 'United_States\nuk2435\nCanada\nGermany'
                      : localConfig.clientType === 'windscribe'
                      ? 'US Central\nCanada East\nUK London\nGermany'
                      : 'Server names (one per line)'
                  }
                  value={localConfig.serverList.join('\n')}
                  onChange={(e) => handleServerListChange(e.target.value)}
                  disabled={disabled}
                  rows={4}
                  className="font-mono text-sm"
                />
                {localConfig.serverList.length > 0 && (
                  <p className="text-xs text-muted-foreground">
                    {localConfig.serverList.length} server{localConfig.serverList.length !== 1 ? 's' : ''} configured
                  </p>
                )}
              </div>

              <div className="pt-4 border-t">
                <details className="space-y-4">
                  <summary className="cursor-pointer text-sm font-medium text-muted-foreground hover:text-foreground">
                    Advanced Settings
                  </summary>
                  <div className="grid gap-4 sm:grid-cols-2 pt-4">
                    <div className="space-y-2">
                      <Label htmlFor="max-retries">Max Connection Retries</Label>
                      <Input
                        id="max-retries"
                        type="number"
                        min="1"
                        max="30"
                        value={localConfig.maxRetries}
                        onChange={(e) => handleChange({ maxRetries: parseInt(e.target.value) || 10 })}
                        disabled={disabled}
                      />
                    </div>
                    <div className="space-y-2">
                      <Label htmlFor="retry-delay">Retry Delay (ms)</Label>
                      <Input
                        id="retry-delay"
                        type="number"
                        min="500"
                        max="10000"
                        step="500"
                        value={localConfig.retryDelay}
                        onChange={(e) => handleChange({ retryDelay: parseInt(e.target.value) || 2000 })}
                        disabled={disabled}
                      />
                    </div>
                    <div className="space-y-2">
                      <Label htmlFor="verify-url">Connection Verify URL</Label>
                      <Input
                        id="verify-url"
                        type="url"
                        value={localConfig.connectionVerifyUrl}
                        onChange={(e) => handleChange({ connectionVerifyUrl: e.target.value })}
                        disabled={disabled}
                      />
                    </div>
                    <div className="space-y-2">
                      <Label htmlFor="ip-tracking">IP Tracking Endpoint</Label>
                      <Input
                        id="ip-tracking"
                        type="url"
                        value={localConfig.ipTrackingEndpoint}
                        onChange={(e) => handleChange({ ipTrackingEndpoint: e.target.value })}
                        disabled={disabled}
                      />
                    </div>
                  </div>
                </details>
              </div>
            </div>

            <div className="rounded-lg bg-blue-50 p-4 border border-blue-200">
              <h4 className="text-sm font-medium text-blue-900 mb-2">Setup Instructions</h4>
              <div className="text-xs text-blue-700 space-y-1">
                {localConfig.clientType === 'nordvpn' && (
                  <>
                    <p>1. Install NordVPN CLI: <code className="bg-blue-100 px-1 rounded">sh &lt;(curl -sSf https://downloads.nordcdn.com/apps/linux/install.sh)</code></p>
                    <p>2. Login: <code className="bg-blue-100 px-1 rounded">nordvpn login --token YOUR_TOKEN</code></p>
                    <p>3. Test connection: <code className="bg-blue-100 px-1 rounded">nordvpn connect</code></p>
                  </>
                )}
                {localConfig.clientType === 'windscribe' && (
                  <>
                    <p>1. Install Windscribe CLI from windscribe.com</p>
                    <p>2. Login: <code className="bg-blue-100 px-1 rounded">windscribe login</code></p>
                    <p>3. Test connection: <code className="bg-blue-100 px-1 rounded">windscribe connect</code></p>
                  </>
                )}
                {localConfig.clientType === 'manual' && (
                  <>
                    <p>When rotation is triggered, you'll be prompted to change your VPN connection manually.</p>
                    <p>The scraper will wait for you to confirm the connection before continuing.</p>
                  </>
                )}
              </div>
            </div>
          </>
        )}
      </CardContent>
    </Card>
  );
}
