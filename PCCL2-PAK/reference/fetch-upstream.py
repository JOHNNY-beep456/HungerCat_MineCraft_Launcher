"""固定提交的最小样式参考下载；使用 Python 默认 TLS 证书校验。"""
import urllib.request
import urllib.parse
import json
import base64
from pathlib import Path
COMMIT = '93ede5d9e638c99fcec853a9ba1eecd91ceee7f5'
files = ['LICENCE', 'Plain Craft Launcher 2/Application.xaml', 'Plain Craft Launcher 2/FormMain.xaml', 'Plain Craft Launcher 2/Controls/MyButton.xaml', 'Plain Craft Launcher 2/Controls/MyButton.xaml.vb', 'Plain Craft Launcher 2/Controls/MyTextBox.vb', 'Plain Craft Launcher 2/Controls/MyComboBox.vb', 'Plain Craft Launcher 2/Controls/MyCard.vb', 'Plain Craft Launcher 2/Controls/MyListItem.xaml', 'Plain Craft Launcher 2/Controls/MyRadioButton.xaml', 'Plain Craft Launcher 2/Modules/ModMain.vb']
root = Path(__file__).parent / 'upstream'
root.mkdir(exist_ok=True)
for source in files:
    url = 'https://api.github.com/repos/Meloong-Git/PCL/contents/' + urllib.parse.quote(source) + '?ref=' + COMMIT
    response = json.load(urllib.request.urlopen(url, timeout=30))
    data = base64.b64decode(response['content'])
    (root / Path(source).name).write_bytes(data)
    print(source, len(data))
