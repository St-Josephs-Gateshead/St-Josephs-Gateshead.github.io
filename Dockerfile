FROM ubuntu:24.04

ENV DEBIAN_FRONTEND=noninteractive

# texlive-full includes gregoriotex + the gregorio binary via texlive-music
# pdfjam is in texlive-extra-utils; poppler-utils for pdfinfo
RUN apt-get update && apt-get install -y --no-install-recommends \
    texlive-full \
    texlive-extra-utils \
    poppler-utils \
    fontconfig \
    fonts-texgyre \
    python3 \
    python3-pip \
    && apt-get clean && rm -rf /var/lib/apt/lists/*

# Verify gregorio binary is present (included in texlive-full since TL 2015)
RUN which gregorio && gregorio --version

CMD ["/bin/bash"]
