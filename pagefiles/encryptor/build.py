import shutil, os, getpass
from contextlib import chdir

try:
    os.makedirs('dist', exist_ok=False)
except FileExistsError:
    shutil.rmtree('dist')
    os.makedirs('dist')

p = getpass.getpass('Password: ')
if getpass.getpass('Confirm Password: ') == p:
    os.system(f"python encryptor/encrypt.py --password {p}")
else:
    print("Passwords do not match.")

shutil.copyfile("index.html", "dist/index.html")
os.makedirs("dist/instructor", exist_ok=True)
shutil.copyfile("instructor/index.html", "dist/instructor/index.html")
shutil.copytree("encrypted/", "dist/encrypted/", dirs_exist_ok=True)
shutil.copytree("dist/", "../encrypted_sat/", dirs_exist_ok=True)
os.system("code ../encrypted_sat/")



print("Build Complete.")