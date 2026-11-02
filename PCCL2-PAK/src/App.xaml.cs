using System.Windows;

namespace PCCL2.Native;
public partial class App : Application
{
    protected override void OnStartup(StartupEventArgs e)
    {
        base.OnStartup(e);
        DispatcherUnhandledException += (_, args) =>
        {
            Console.Error.WriteLine("PCCL2 UI: " + args.Exception.GetType().Name);
            MessageBox.Show(args.Exception.Message, "PCCL2", MessageBoxButton.OK, MessageBoxImage.Error);
            args.Handled = true;
        };
        var window = new MainWindow(e.Args.Contains("--bridge-stdio"));
        MainWindow = window;
        window.Show();
    }
}
