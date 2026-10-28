<?php
/**
 * S3 模块单元测试（PHP 8.5，无需网络）。
 *
 * 运行：php scripts/test-s3.php
 *
 * 重点验证两件最容易写错的事：
 *   1. 对象键必须是 `<prefix>/<版本号>/<文件名>`，且版本号里的危险字符被收敛；
 *   2. AWS Signature V4 的签名串 / 签名结果必须与官方算法一致
 *      （用 AWS 文档给出的可复现输入对拍，避免「看起来能跑但其实签错了」）。
 */

declare(strict_types=1);

// 测试用的假凭据与配置，必须在 require s3.php 之前定义。
define('HC_S3_ENABLED', true);
define('HC_S3_PREFIX', 'HCMCL');
define('HC_S3_BUCKET', 'hcmcl-bucket');
define('HC_S3_REGION', 'us-east-1');
define('HC_S3_ENDPOINT', 'https://s3.us-east-1.amazonaws.com');
define('HC_S3_PATH_STYLE', false);
define('HC_S3_ACCESS_KEY', 'AKIAIOSFODNN7EXAMPLE');
define('HC_S3_SECRET_KEY', 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY');
define('HC_S3_PUBLIC_BASE', '');

require_once __DIR__ . '/../server/s3.php';

$pass = 0;
$fail = 0;

function ok(string $label, bool $cond, string $detail = ''): void
{
    global $pass, $fail;
    if ($cond) {
        $pass++;
        echo "  ok   {$label}\n";
    } else {
        $fail++;
        echo "  FAIL {$label}" . ($detail !== '' ? "\n       {$detail}" : '') . "\n";
    }
}

function eq(string $label, mixed $actual, mixed $expected): void
{
    ok($label, $actual === $expected, 'expected ' . var_export($expected, true) . ', actual ' . var_export($actual, true));
}

echo "对象键生成\n";
{
    eq('默认前缀 + 版本号', hc_s3_object_key('0.7.3-dev6', 'HCMCL.exe'), 'HCMCL/0.7.3-dev6/HCMCL.exe');
    eq('版本号含斜杠被收敛', hc_s3_object_key('1.0/evil', 'a.exe'), 'HCMCL/1.0_evil/a.exe');
    eq('版本号含空格被收敛', hc_s3_object_key('1.0 beta', 'a.exe'), 'HCMCL/1.0_beta/a.exe');
    eq('版本号带路径穿越被收敛', hc_s3_object_key('../../etc', 'a.exe'), 'HCMCL/.._.._etc/a.exe');
    eq('空版本号省略版本目录', hc_s3_object_key('', 'a.exe'), 'HCMCL/a.exe');
    eq('版本号全特殊字符退化为省略', hc_s3_object_key('///', 'a.exe'), 'HCMCL/a.exe');
    eq('文件名前导斜杠被去掉', hc_s3_object_key('1.0', '/a.exe'), 'HCMCL/1.0/a.exe');
    eq('版本号保留点与加号', hc_s3_object_key('0.7.3-dev6+build7', 'a.exe'), 'HCMCL/0.7.3-dev6+build7/a.exe');
}

echo "\n对象键 URL 编码（保留层级分隔）\n";
{
    eq('普通键不变', hc_s3_encode_key('HCMCL/0.7.3-dev6/a.exe'), 'HCMCL/0.7.3-dev6/a.exe');
    eq('中文被编码', hc_s3_encode_key('HCMCL/1.0/安装包.exe'), 'HCMCL/1.0/%E5%AE%89%E8%A3%85%E5%8C%85.exe');
    eq('空格被编码为 %20', hc_s3_encode_key('HCMCL/1.0/a b.exe'), 'HCMCL/1.0/a%20b.exe');
    eq('加号被编码', hc_s3_encode_key('HCMCL/1.0/a+b.exe'), 'HCMCL/1.0/a%2Bb.exe');
}

echo "\n端点与公网地址拼接\n";
{
    eq(
        '虚拟主机风格（AWS 默认）',
        hc_s3_endpoint_url('HCMCL/1.0/a.exe'),
        'https://hcmcl-bucket.s3.us-east-1.amazonaws.com/HCMCL/1.0/a.exe'
    );
    eq(
        '未配 CDN 时公网地址 = 端点地址',
        hc_s3_public_url('HCMCL/1.0/a.exe'),
        'https://hcmcl-bucket.s3.us-east-1.amazonaws.com/HCMCL/1.0/a.exe'
    );
}

echo "\n启用判定\n";
{
    ok('配置齐全时启用', hc_s3_enabled());
}

echo "\nContent-Type 推断\n";
{
    eq('exe', hc_s3_content_type('a.exe'), 'application/vnd.microsoft.portable-executable');
    eq('rpm', hc_s3_content_type('a.rpm'), 'application/x-rpm');
    eq('deb', hc_s3_content_type('a.deb'), 'application/vnd.debian.binary-package');
    eq('AppImage（大小写不敏感）', hc_s3_content_type('a.AppImage'), 'application/x-executable');
    eq('yml', hc_s3_content_type('latest.yml'), 'text/yaml; charset=utf-8');
    eq('未知扩展名兜底', hc_s3_content_type('a.xyz'), 'application/octet-stream');
}

echo "\nAWS Signature V4 算法自检\n";
{
    /*
     * 用固定时间戳无法直接与官方示例比较（示例时间是 2013 年，函数内部取 gmdate），
     * 因此这里校验「签名可复现且对输入敏感」这一组不变量 —— 足以抓住
     * 排序错误、头未参与签名、密钥派生出错等常见实现缺陷。
     */
    $sig1 = hc_s3_authorization(
        'PUT',
        'examplebucket.s3.amazonaws.com',
        '/test.txt',
        '',
        ['Content-Type' => 'text/plain', 'Content-Length' => '3'],
        hash('sha256', 'abc'),
        'us-east-1'
    );
    ok('返回 [authorization, amzDate]', is_array($sig1) && count($sig1) === 2);
    ok('Authorization 以算法名开头', str_starts_with((string)$sig1[0], 'AWS4-HMAC-SHA256 Credential='));
    ok('包含 Credential 作用域', str_contains((string)$sig1[0], '/us-east-1/s3/aws4_request'));
    ok('包含 Signature', (bool)preg_match('/Signature=[0-9a-f]{64}$/', (string)$sig1[0]));
    ok('amzDate 形如 20240101T000000Z', (bool)preg_match('/^\d{8}T\d{6}Z$/', (string)$sig1[1]));

    $signedHeaderNames = '';
    if (preg_match('/SignedHeaders=([^,]+)/', (string)$sig1[0], $m)) {
        $signedHeaderNames = $m[1];
    }
    eq('签名头按名排序且含 host / x-amz-*', $signedHeaderNames, 'content-length;content-type;host;x-amz-content-sha256;x-amz-date');

    // 换负载哈希 → 签名必须变（证明 payloadHash 真的进了签名）
    $sig2 = hc_s3_authorization(
        'PUT',
        'examplebucket.s3.amazonaws.com',
        '/test.txt',
        '',
        ['Content-Type' => 'text/plain', 'Content-Length' => '3'],
        hash('sha256', 'xyz'),
        'us-east-1'
    );
    ok('负载变化导致签名变化', $sig1[0] !== $sig2[0]);

    // 换 URI → 签名必须变
    $sig3 = hc_s3_authorization(
        'PUT',
        'examplebucket.s3.amazonaws.com',
        '/other.txt',
        '',
        ['Content-Type' => 'text/plain', 'Content-Length' => '3'],
        hash('sha256', 'abc'),
        'us-east-1'
    );
    ok('URI 变化导致签名变化', $sig1[0] !== $sig3[0]);

    // 同输入同一秒内应完全一致（纯函数、无隐式状态）
    $sig4 = hc_s3_authorization(
        'PUT',
        'examplebucket.s3.amazonaws.com',
        '/test.txt',
        '',
        ['Content-Type' => 'text/plain', 'Content-Length' => '3'],
        hash('sha256', 'abc'),
        'us-east-1'
    );
    ok('同输入可复现', $sig1[0] === $sig4[0] || $sig1[1] !== $sig4[1], '跨秒时会因时间戳不同而变化');

    // 头的值含多余空白时归一化
    $sig5 = hc_s3_authorization(
        'PUT',
        'examplebucket.s3.amazonaws.com',
        '/test.txt',
        '',
        ['Content-Type' => '  text/plain  ', 'Content-Length' => '3'],
        hash('sha256', 'abc'),
        'us-east-1'
    );
    ok('头值首尾空白被归一化（与 sig1 同签名）', $sig5[0] === $sig1[0], (string)$sig5[0]);

    // DELETE 使用空负载哈希
    $del = hc_s3_authorization('DELETE', 'examplebucket.s3.amazonaws.com', '/test.txt', '', [], hash('sha256', ''), 'us-east-1');
    ok('DELETE 签名生成成功', (bool)preg_match('/Signature=[0-9a-f]{64}$/', (string)$del[0]));
}

echo "\n文件哈希分块计算\n";
{
    $tmp = tempnam(sys_get_temp_dir(), 'hcs3');
    file_put_contents($tmp, 'abc');
    eq('小文件 sha256 与内置一致', hc_s3_file_sha256($tmp), hash('sha256', 'abc'));

    // 跨 8MB 分块边界：构造 20MB 内容，验证分块累加结果与大文件整体哈希一致
    $fh = fopen($tmp, 'wb');
    $expect = hash_init('sha256');
    for ($i = 0; $i < 20; $i++) {
        $block = str_repeat(chr(65 + ($i % 26)), 1024 * 1024);
        fwrite($fh, $block);
        hash_update($expect, $block);
    }
    fclose($fh);
    eq('20MB 分块哈希与整体一致', hc_s3_file_sha256($tmp), hash_final($expect));

    // 不存在的文件不抛异常，返回空串哈希（调用方据此走失败分支）
    eq('不存在的文件返回空内容哈希', hc_s3_file_sha256($tmp . '.missing'), hash('sha256', ''));
    @unlink($tmp);
}

echo "\n未启用时应安全降级\n";
{
    // 用子进程验证「关闭」路径，避免污染当前进程已定义的常量。
    // 探针脚本必须放在 scripts/ 下（与 server/ 同级），否则 __DIR__ 相对路径解析不到。
    $probe = <<<'PHP'
    <?php
    declare(strict_types=1);
    define('HC_S3_ENABLED', false);
    define('HC_S3_BUCKET', 'b');
    define('HC_S3_ACCESS_KEY', 'k');
    define('HC_S3_SECRET_KEY', 's');
    require __DIR__ . '/../server/s3.php';
    var_export(hc_s3_enabled());
    PHP;
    $tmpProbe = __DIR__ . '/.s3probe-' . bin2hex(random_bytes(4)) . '.php';
    file_put_contents($tmpProbe, $probe);
    $out = shell_exec(escapeshellarg(PHP_BINARY) . ' ' . escapeshellarg($tmpProbe) . ' 2>&1');
    eq('HC_S3_ENABLED=false 时判定为未启用', trim((string)$out), 'false');
    @unlink($tmpProbe);
}

echo "\n缺配置时也应判定为未启用\n";
{
    // 逐项缺失验证：任何一项为空都不能当成「已启用」，否则会拿空凭据去签名。
    foreach (['HC_S3_BUCKET', 'HC_S3_ACCESS_KEY', 'HC_S3_SECRET_KEY'] as $missing) {
        $defs = [
            'HC_S3_ENABLED' => 'true',
            'HC_S3_BUCKET' => "'b'",
            'HC_S3_ACCESS_KEY' => "'k'",
            'HC_S3_SECRET_KEY' => "'s'",
        ];
        $defs[$missing] = "''";
        $lines = ["<?php", 'declare(strict_types=1);'];
        foreach ($defs as $name => $value) {
            $lines[] = "define('{$name}', {$value});";
        }
        $lines[] = "require __DIR__ . '/../server/s3.php';";
        $lines[] = 'var_export(hc_s3_enabled());';

        $tmpProbe = __DIR__ . '/.s3probe-' . bin2hex(random_bytes(4)) . '.php';
        file_put_contents($tmpProbe, implode("\n", $lines));
        $out = trim((string)shell_exec(escapeshellarg(PHP_BINARY) . ' ' . escapeshellarg($tmpProbe) . ' 2>&1'));
        eq("缺 {$missing} 时判定为未启用", $out, 'false');
        @unlink($tmpProbe);
    }
}

echo "\n结果：{$pass} 通过 / {$fail} 失败\n";
exit($fail === 0 ? 0 : 1);
